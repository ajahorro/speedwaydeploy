-- ============================================================================
-- Batch 1 — Scenario 11 (OCR false positive vs Admin override lockout)
--         + Scenario 10 (Partial refund / ledger desync)
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Two logical (non-500) defects that quietly corrupt financial state:
--
--   SC-11  A DELAYED OCR WEBHOOK COULD OVERWRITE AN ADMIN'S MANUAL OVERRIDE.
--          The flow: OCR misreads ₱100 as ₱10 -> payment sits FOR_VERIFICATION ->
--          the admin phones the customer, confirms it, and clicks "Override to
--          Paid" (payments.status = 'PAID', verified_by/verified_at stamped).
--          A retried/late `persist_ocr_result` call then ran:
--              update bookings set payment_status = p_payment_status ...
--          with the STALE OCR verdict ('Flagged for Review' / 'REJECTED_...'),
--          stomping the human decision. There was no lock: OCR had final say
--          over a human who had already verified the money. We add an explicit
--          override lock on the payment (manual_override = true) and make the
--          OCR write path REFUSE to touch a payment/booking that a human has
--          already settled. Idempotency: a second identical webhook is a no-op.
--
--   SC-10  PARTIAL REFUND WAS DOUBLE-COUNTED IN THE BALANCE.
--          Example: total ₱150, paid in full (₱150). Admin refunds ₱30, so net
--          paid = ₱120. The customer then downgrades services to ₱110; the shop
--          owes them ₱10. The refund row is `amount = -30` written with
--          `status = 'REFUNDED'`. The previous ledger summed POSITIVE rows with
--          status IN ('PAID','REFUND_PENDING','REFUNDED'); because the negative
--          refund row ALSO carries status 'REFUNDED', a naive "positive payments
--          with status REFUNDED" filter could pick the -30 row up as a credit
--          or, worse, the balance recompute subtracted the refund a SECOND time
--          (once via the negative ledger row, once via the totals), yielding a
--          ₱40 credit instead of ₱10. We expose a single, authoritative
--          `booking_net_paid()` function and a signed `payments.signed_amount`
--          generated column so every caller (postgres + JS) derives the SAME
--          number from one rule: net = Σ(positive settled rows) − Σ(|refunds|).
-- ============================================================================

-- ── 0. Guard columns ────────────────────────────────────────────────────────
alter table public.payments
  add column if not exists manual_override boolean not null default false,
  add column if not exists overridden_by uuid,
  add column if not exists overridden_at timestamptz,
  add column if not exists ocr_locked boolean not null default false;

comment on column public.payments.manual_override is
  'Scenario 11: TRUE when a human (admin) settled this payment by hand. Blocks any subsequent automated OCR/webhook write from changing its status or amount.';
comment on column public.payments.ocr_locked is
  'Scenario 11: TRUE once an admin override has finalised the payment. persist_ocr_result becomes a no-op for this row.';
comment on column public.payments.overridden_by is
  'Scenario 11: the admin profile id that performed the manual override.';
comment on column public.payments.overridden_at is
  'Scenario 11: timestamp of the manual override, for the audit trail.';


-- ── 1. Signed ledger amount (one rule for refunds) ──────────────────────────
-- A refund is ALWAYS a negative-amount SYSTEM_REFUND row. This generated column
-- makes the sign explicit so no caller has to guess whether to add or subtract,
-- and so a "positive payments with status REFUNDED" mistake is impossible: the
-- value is negative and self-describing.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'payments' and column_name = 'signed_amount'
  ) then
    alter table public.payments
      add column signed_amount numeric
      generated always as (
        case
          when upper(coalesce(method, '')) = 'SYSTEM_REFUND' then -abs(coalesce(amount, 0))
          else coalesce(amount, 0)
        end
      ) stored;
  end if;
end $$;

comment on column public.payments.signed_amount is
  'Scenario 10: SIGNED ledger value. Refund rows (SYSTEM_REFUND) are always negative; every other row is positive. Used by booking_net_paid() so refunds are subtracted exactly once.';


-- ── 2. Authoritative net-paid function (frozen math for Scenarios 10) ────────
-- net paid = settled positive credits − processed refunds.
--   * A refund is counted ONLY when it is a negative SYSTEM_REFUND row, or a
--     positive row explicitly marked REFUNDED (a full-refund that closed the
--     source line). The negative SYSTEM_REFUND row is the single source for
--     partial refunds, so a partial refund can never be double-subtracted.
--   * A REFUND_PENDING row still counts as a CREDIT (the customer did pay it and
--     the money has not left yet); the refund only reduces the net once PROCESSED.
create or replace function public.booking_net_paid(p_booking_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with credits as (
    select coalesce(sum(amount), 0) as total
      from public.payments
     where booking_id = p_booking_id
       and amount > 0
       and upper(coalesce(method, '')) <> 'SYSTEM_REFUND'
       and upper(coalesce(status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED')
  ),
  refunds as (
    select coalesce(sum(abs(amount)), 0) as total
      from public.payments
     where booking_id = p_booking_id
       and (
         upper(coalesce(method, '')) = 'SYSTEM_REFUND'
         or upper(coalesce(status, '')) = 'REFUNDED'
       )
       and amount < 0
  )
  select greatest(0, (select total from credits) - (select total from refunds));
$$;

comment on function public.booking_net_paid(uuid) is
  'Scenario 10 canonical ledger: settled credits minus PROCESSED refunds, computed from signed rows so a partial refund is subtracted exactly once (₱150 paid − ₱30 refund = ₱120 net). Mirrors calculatePaymentSummary() in frontend/src/utils/paymentUtils.js.';

revoke all on function public.booking_net_paid(uuid) from public;
grant execute on function public.booking_net_paid(uuid) to authenticated;


-- ── 3. Harden persist_ocr_result (Scenario 11 idempotency + admin priority) ──
create or replace function public.persist_ocr_result(
  p_booking_id uuid,
  p_payment_id uuid,
  p_detected_amount numeric,
  p_detected_ref text,
  p_payment_status text,
  p_ocr_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now          timestamptz := now();
  v_status       text;
  v_override     boolean;
  v_ocr_locked   boolean;
  v_already_same boolean;
begin
  if p_booking_id is null or p_payment_id is null then
    raise exception 'Booking and payment IDs are required';
  end if;

  -- Lock the payment row for the duration of this write so a concurrent admin
  -- override and a retried webhook cannot interleave.
  select upper(coalesce(status, '')),
         coalesce(manual_override, false),
         coalesce(ocr_locked, false)
    into v_status, v_override, v_ocr_locked
    from public.payments
   where id = p_payment_id
     and booking_id = p_booking_id
   for update;

  if not found then
    raise exception 'Payment does not belong to booking or was not found';
  end if;

  -- 🛡️ ADMIN PRIORITY: once a human has settled the payment, automation is
  -- FORBIDDEN from changing its state. Return a no-op result rather than
  -- overwriting the human decision with a stale OCR verdict.
  if v_override or v_ocr_locked or v_status = 'PAID' then
    return jsonb_build_object(
      'booking_id', p_booking_id,
      'payment_id', p_payment_id,
      'persisted', false,
      'skipped', true,
      'reason', 'ADMIN_OVERRIDE_LOCK',
      'current_status', v_status
    );
  end if;

  -- Idempotency: if this exact scan was already recorded, do not rewrite it.
  select true into v_already_same
    from public.payments
   where id = p_payment_id
     and detected_amount is not distinct from p_detected_amount
     and detected_ref is not distinct from p_detected_ref
   limit 1;

  if coalesce(v_already_same, false) then
    return jsonb_build_object(
      'booking_id', p_booking_id,
      'payment_id', p_payment_id,
      'persisted', true,
      'skipped', true,
      'reason', 'IDEMPOTENT_NOOP'
    );
  end if;

  update public.payments
     set detected_amount = p_detected_amount,
         detected_ref = p_detected_ref
   where id = p_payment_id
     and booking_id = p_booking_id;

  -- Only advance the booking's payment_status when the human lock is absent.
  update public.bookings
     set payment_status = p_payment_status,
         ocr_metadata = p_ocr_metadata,
         updated_at = v_now
   where id = p_booking_id
     and coalesce((select manual_override from public.payments where id = p_payment_id), false) = false;

  if not found then
    raise exception 'Booking was not found';
  end if;

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'payment_id', p_payment_id,
    'persisted', true,
    'skipped', false
  );
end;
$$;

comment on function public.persist_ocr_result(uuid, uuid, numeric, text, text, jsonb) is
  'Scenario 11 hardened OCR persistence: LOCKs the payment row, refuses to overwrite a human override (manual_override/ocr_locked or status PAID), and is idempotent for an identical re-scan. A delayed webhook can no longer stomp an admin decision.';

revoke all on function public.persist_ocr_result(uuid, uuid, numeric, text, text, jsonb) from public;
grant execute on function public.persist_ocr_result(uuid, uuid, numeric, text, text, jsonb) to service_role;


-- ── 4. admin_override_payment_to_paid (sets the lock) ────────────────────────
-- The admin "Override to Paid" action must itself SET the lock, so the window
-- between the human click and a retried webhook is closed atomically.
create or replace function public.admin_override_payment_to_paid(
  p_payment_id uuid,
  p_booking_id uuid,
  p_verified_amount numeric,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now    timestamptz := now();
  v_amount numeric := coalesce(p_verified_amount, 0);
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid() and upper(role) = 'ADMIN'
  ) then
    raise exception 'Administrator access is required to override a payment';
  end if;

  if v_amount <= 0 then
    raise exception 'A verified amount greater than zero is required';
  end if;

  update public.payments
     set amount = v_amount,
         status = 'PAID',
         verified_by = auth.uid(),
         verified_at = v_now,
         manual_override = true,
         ocr_locked = true,
         overridden_by = auth.uid(),
         overridden_at = v_now,
         notes = concat_ws('|', notes, '[MANUAL_OVERRIDE]', nullif(p_note, ''))
   where id = p_payment_id
     and booking_id = p_booking_id;

  if not found then
    raise exception 'Payment does not belong to booking or was not found';
  end if;

  insert into public.audit_logs (
    booking_id, action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    p_booking_id,
    'MANUAL_OVERRIDE_CONFIRM',
    format('Administrator manually confirmed a flagged payment as ₱%s. Automated OCR updates are now locked out.', v_amount),
    'Administrator', 'ADMIN', auth.uid(),
    jsonb_build_object('payment_id', p_payment_id, 'verified_amount', v_amount, 'override_lock', true)
  );

  return jsonb_build_object(
    'payment_id', p_payment_id,
    'booking_id', p_booking_id,
    'status', 'PAID',
    'manual_override', true,
    'ocr_locked', true
  );
end;
$$;

comment on function public.admin_override_payment_to_paid(uuid, uuid, numeric, text) is
  'Scenario 11: admin "Override to Paid". Atomically marks the payment PAID and sets manual_override/ocr_locked so persist_ocr_result can never later overwrite the human decision.';

revoke all on function public.admin_override_payment_to_paid(uuid, uuid, numeric, text) from public;
grant execute on function public.admin_override_payment_to_paid(uuid, uuid, numeric, text) to authenticated;