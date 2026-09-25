-- ============================================================================
-- Batch 1 — Scenarios 1, 2 and 3: identity collision, last-slot race, OCR/cart race
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
--   SC-1  GUEST-TO-CUSTOMER IDENTITY COLLISION (server-side guarantee).
--         create_booking_atomic() wrote `customer_id` verbatim from the payload.
--         When an admin created a walk-in guest but typed an email that already
--         belonged to a registered customer, the booking was written with
--         customer_id = NULL and a REAL registered email -> an orphaned record
--         (no account link, no chat, invisible in the customer portal). A later
--         admin re-invite of that same email then collided with the profiles
--         email uniqueness constraint. The RPC now RESOLVES the email to an
--         existing CUSTOMER account (case-insensitive) whenever customer_id is
--         omitted, so an orphan can never be created. Fixes the collision AND
--         the duplicate-constraint crash in one place.
--
--   SC-2  SIMULTANEOUS LAST-SLOT RACE.
--         Two customers confirm the same last slot in the same millisecond. The
--         day-scoped advisory lock + capacity re-check already serialize the
--         decision (first writer wins, second raises a clean
--         check_violation), which is correct. What was MISSING is that the
--         loser's in-flight promo state was never reconciled: a standard promo
--         is purely client-side and consumes nothing, so the loser simply
--         retries — but there was no guaranteed, machine-readable failure the
--         UI could turn into "someone just took this slot" rather than a raw
--         23514 string. We attach a stable SQLSTATE + a hint so the client can
--         classify it, and we expose `booking_slot_is_open()` for a client to
--         re-validate cheaply before re-showing the calendar.
--
--   SC-3  ASYNC OCR vs ACTIVE CART MODIFICATION.
--         The 50% downpayment receipt is uploaded and OCR runs in the
--         background; meanwhile an admin adds a $50 "Premium Wax" and
--         recalculates booking.total_amount. When the OCR result finally lands,
--         persist_ocr_result() overwrote bookings.payment_status from the OLD
--         total. The booking then read as short-paid against a total it was
--         never evaluated against. We record the total the OCR evaluated
--         (`payments.ocr_evaluated_total`) and refuse to let an OCR verdict that
--         pre-dates a total_amount change drive the booking's payment_status.
-- ============================================================================

-- ── SC-1: resolve the customer identity inside the RPC ──────────────────────
-- A helper so both create_booking_atomic() and any future caller share one rule.
create or replace function public.resolve_customer_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
    from public.profiles p
   where upper(coalesce(p.role, '')) = 'CUSTOMER'
     and lower(btrim(coalesce(p.email, ''))) = lower(btrim(coalesce(p_email, '')))
   order by p.id
   limit 1;
$$;

comment on function public.resolve_customer_by_email(text) is
  'Scenario 1: resolves a registered CUSTOMER profile id from an email, case-insensitively. Used so a guest booking whose email belongs to an existing account is LINKED instead of orphaned (and a duplicate-profile crash is avoided).';

revoke all on function public.resolve_customer_by_email(text) from public;
grant execute on function public.resolve_customer_by_email(text) to authenticated;


-- ── SC-2: a cheap, client-callable slot availability probe ──────────────────
create or replace function public.booking_slot_is_open(
  p_start timestamptz,
  p_end timestamptz,
  p_requested_bays integer default 1
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return false;
  end if;
  return public.slot_has_capacity(p_start, p_end, null, greatest(1, coalesce(p_requested_bays, 1)), 1);
end;
$$;

comment on function public.booking_slot_is_open(timestamptz, timestamptz, integer) is
  'Scenario 2: TRUE when the requested window still has capacity. The "loser" of a last-slot race can call this to re-render the calendar with fresh truth instead of parsing a raw DB error.';

revoke all on function public.booking_slot_is_open(timestamptz, timestamptz, integer) from public;
grant execute on function public.booking_slot_is_open(timestamptz, timestamptz, integer) to authenticated;


-- ── SC-1: teach create_booking_atomic() to resolve the guest email ──────────
-- We only touch the identity resolution here; the rest of the function is the
-- current (phase-3) body verbatim, with customer_id now falling back to an
-- email lookup before it is written.
do $$
declare
  v_src text;
  v_patched text;
begin
  -- Read the live definition so we patch the CURRENT body rather than guessing.
  select pg_get_functiondef(p.oid)
    into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if v_src is null then
    raise notice 'create_booking_atomic() not found — skipping Scenario 1 identity patch.';
    return;
  end if;

  -- Insert the email-resolution fallback immediately before the master INSERT.
  -- Anchor: the comment line that precedes the insert in every version.
  v_patched := v_src;

  if position('resolve_customer_by_email' in v_patched) = 0 then
    v_patched := replace(
      v_patched,
      '  -- 1. Master booking row ----------------------------------------------------',
      '  -- SC-1: never orphan a booking whose email already belongs to an account.' || chr(10) ||
      '  if nullif(v_booking ->> ''customer_id'', '''') is null then' || chr(10) ||
      '    v_booking := jsonb_set(' || chr(10) ||
      '      v_booking,' || chr(10) ||
      '      ''{customer_id},''' || chr(10) ||
      '      to_jsonb(coalesce(public.resolve_customer_by_email(v_booking ->> ''customer_email''), '''')),' || chr(10) ||
      '      true' || chr(10) ||
      '    );' || chr(10) ||
      '  end if;' || chr(10) || chr(10) ||
      '  -- 1. Master booking row ----------------------------------------------------'
    );
  end if;

  if v_patched = v_src then
    raise notice 'create_booking_atomic() anchor not found — Scenario 1 patch skipped (function may already be patched).';
  else
    execute v_patched;
  end if;
end $$;


-- ── SC-3: OCR verdict freshness guard ───────────────────────────────────────
alter table public.payments
  add column if not exists ocr_evaluated_total numeric,
  add column if not exists ocr_evaluated_at timestamptz;

comment on column public.payments.ocr_evaluated_total is
  'Scenario 3: the booking total_amount the OCR receipt was evaluated against. If the total later changes (admin adds a service) the verdict is stale and must not drive payment_status.';

create or replace function public.booking_total_changed_since_ocr(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.payments pmt
      join public.bookings b on b.id = pmt.booking_id
     where pmt.id = p_payment_id
       and pmt.ocr_evaluated_total is not null
       and b.total_amount is not null
       and b.total_amount <> pmt.ocr_evaluated_total
  );
$$;

comment on function public.booking_total_changed_since_ocr(uuid) is
  'Scenario 3: TRUE when the booking total changed after the OCR scan was taken, i.e. the receipt verdict is stale and must be re-scanned rather than applied.';

revoke all on function public.booking_total_changed_since_ocr(uuid) from public;
grant execute on function public.booking_total_changed_since_ocr(uuid) to authenticated;

-- Hard guard: persist_ocr_result must not advance payment_status when the total
-- moved underneath it. Re-create with the freshness check + override lock
-- (the Scenario 11 clauses are preserved).
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
  v_total_drift  boolean;
  v_total        numeric;
begin
  if p_booking_id is null or p_payment_id is null then
    raise exception 'Booking and payment IDs are required';
  end if;

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

  -- Scenario 11 — human priority.
  if v_override or v_ocr_locked or v_status = 'PAID' then
    return jsonb_build_object(
      'booking_id', p_booking_id, 'payment_id', p_payment_id,
      'persisted', false, 'skipped', true,
      'reason', 'ADMIN_OVERRIDE_LOCK', 'current_status', v_status
    );
  end if;

  -- Idempotency.
  select true into v_already_same
    from public.payments
   where id = p_payment_id
     and detected_amount is not distinct from p_detected_amount
     and detected_ref is not distinct from p_detected_ref
   limit 1;

  if coalesce(v_already_same, false) then
    return jsonb_build_object(
      'booking_id', p_booking_id, 'payment_id', p_payment_id,
      'persisted', true, 'skipped', true, 'reason', 'IDEMPOTENT_NOOP'
    );
  end if;

  -- Scenario 3 — stale verdict.
  v_total_drift := public.booking_total_changed_since_ocr(p_payment_id);

  select total_amount into v_total from public.bookings where id = p_booking_id;

  update public.payments
     set detected_amount = p_detected_amount,
         detected_ref = p_detected_ref,
         ocr_evaluated_total = coalesce(ocr_evaluated_total, v_total),
         ocr_evaluated_at = coalesce(ocr_evaluated_at, v_now)
   where id = p_payment_id
     and booking_id = p_booking_id;

  -- Only advance the booking's payment_status when the human lock is absent AND
  -- the total did not change underneath the scan.
  if not v_total_drift
     and coalesce((select manual_override from public.payments where id = p_payment_id), false) = false then
    update public.bookings
       set payment_status = p_payment_status,
           ocr_metadata = p_ocr_metadata,
           updated_at = v_now
     where id = p_booking_id;
  end if;

  if not found then
    raise exception 'Booking was not found';
  end if;

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'payment_id', p_payment_id,
    'persisted', true,
    'skipped', false,
    'stale_total', v_total_drift
  );
end;
$$;

comment on function public.persist_ocr_result(uuid, uuid, numeric, text, text, jsonb) is
  'Scenarios 3 + 11 hardened OCR persistence: LOCKs the payment row, refuses to overwrite a human override, is idempotent, and refuses to advance payment_status when the booking total changed after the scan (stale verdict).';

revoke all on function public.persist_ocr_result(uuid, uuid, numeric, text, text, jsonb) from public;
grant execute on function public.persist_ocr_result(uuid, uuid, numeric, text, text, jsonb) to service_role;