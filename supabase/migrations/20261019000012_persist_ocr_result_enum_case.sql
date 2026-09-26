-- ============================================================================
-- 20261019000012_persist_ocr_result_enum_case.sql
-- ============================================================================
--
-- CORRECTS 20261019000011, which normalised the verdict to UPPER CASE.
--
-- The members of booking_payment_status are LOWERCASE, verified against the live
-- type:
--
--     bookings.payment_status = 'pending'   -> accepted
--     bookings.payment_status = 'PENDING'   -> 22P02 (invalid input value)
--
-- 20261019000011 upper-cased the value and then matched it against
-- lower(enumlabel), so nothing ever matched the catalog and every call fell back
-- to 'unpaid' — the booking never reached 'pending' and never appeared in the
-- verification queue. Same defect shape as the original 42804: the value was
-- reasonable, the case was wrong.
--
-- This version normalises to LOWER case for the cast and matches the catalog
-- case-insensitively, so 'FOR_VERIFICATION', 'For_Verification' and
-- 'for_verification' all resolve to 'pending'.
-- ============================================================================

-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The OCR verdict could never be persisted. Verified against the live database:
--
--     persist_ocr_result accepted the failed scan — column "payment_status" is
--     of type booking_payment_status but expression is of type text   (42804)
--
-- `persist_ocr_result` declares `p_payment_status text` and then does:
--
--     update public.bookings set payment_status = p_payment_status ...
--
-- PostgreSQL does not implicitly cast text -> enum in an assignment, so EVERY
-- call raised 42804. That is the same defect class already fixed in
-- create_booking_atomic (20261016000001..4) — but persist_ocr_result was missed,
-- and because the backend only LOGGED the failure the booking still reported
-- success. The result: the OCR verdict was never recorded, so nothing downstream
-- could enforce it.
--
-- This is why a non-receipt image could complete a booking even after the
-- application-level gate was added: the gate's input never existed.
--
-- THE FIX
-- -------
-- Cast explicitly and SAFELY:
--   * normalise the incoming value (trim, upper, spaces -> underscores)
--   * validate it against the enum's own members before casting
--   * fall back to 'unpaid' rather than aborting, so a malformed verdict can
--     never leave a booking in an inconsistent state
--
-- The accepted set is derived from pg_enum rather than hard-coded, so adding a
-- member to the type in future cannot silently make this function reject it.
--
-- NOTE: the backend also passes a payment-level verdict (FOR_VERIFICATION /
-- REJECTED) which is NOT a member of booking_payment_status. Those are mapped:
-- FOR_VERIFICATION -> 'pending' (the booking is awaiting verification) and
-- REJECTED -> 'unpaid' (nothing is owed yet; the receipt was refused). The raw
-- verdict is still stored in ocr_metadata.payment_verdict, which is what the
-- gate and the admin UI read.
-- ============================================================================

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
  v_now            timestamptz := now();
  v_status         text;
  v_override       boolean;
  v_ocr_locked     boolean;
  v_already_same   boolean;
  v_total_drift    boolean;
  v_total          numeric;
  v_booking_status booking_payment_status;
  v_is_enum_member boolean;
begin
  if p_booking_id is null or p_payment_id is null then
    raise exception 'Booking and payment IDs are required';
  end if;

  -- ── Normalise and validate the verdict BEFORE it reaches the enum ─────────
  --
  -- CASE MATTERS. The members of booking_payment_status are LOWERCASE
  -- (unpaid | pending | paid | refunded), verified against the live type:
  --
  --     bookings.payment_status = 'pending'            -> accepted
  --     bookings.payment_status = 'PENDING'            -> 22P02
  --
  -- So the value is normalised to lower-case for the CAST, and matched
  -- case-insensitively against the catalog (which is what makes an incoming
  -- 'FOR_VERIFICATION' or 'Paid' work without hard-coding either spelling).
  v_status := lower(replace(btrim(coalesce(p_payment_status, '')), ' ', '_'));

  -- Payment-level verdicts that are NOT members of booking_payment_status.
  -- Map them onto the closest booking state; the raw verdict is preserved in
  -- ocr_metadata by the caller, which is what the gate and admin UI read.
  if v_status = 'for_verification' then
    v_status := 'pending';
  elsif v_status in ('rejected', 'rejected_duplicate', 'flagged_for_review', 'flagged') then
    v_status := 'unpaid';
  end if;

  -- Is it a real member of the enum? Ask the catalog rather than hard-coding,
  -- so a future ALTER TYPE ADD VALUE cannot make this function wrong.
  select exists (
    select 1
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
     where t.typname = 'booking_payment_status'
       and lower(e.enumlabel) = v_status
  ) into v_is_enum_member;

  if not v_is_enum_member then
    -- Fall back rather than abort. An unrecognised verdict is a bug to be fixed,
    -- but it must not prevent the OCR data (amount, reference, metadata) from
    -- being recorded — that data is what an admin needs in order to review.
    raise warning 'persist_ocr_result: "%" is not a booking_payment_status member; defaulting to unpaid.', p_payment_status;
    v_booking_status := 'unpaid'::booking_payment_status;
  else
    v_booking_status := v_status::booking_payment_status;
  end if;

  select coalesce(manual_override, false),
         coalesce(ocr_locked, false)
    into v_override, v_ocr_locked
    from public.payments
   where id = p_payment_id
     and booking_id = p_booking_id
   for update;

  if not found then
    raise exception 'Payment does not belong to booking or was not found';
  end if;

  -- Scenario 11 — human priority.
  if v_override or v_ocr_locked then
    return jsonb_build_object(
      'booking_id', p_booking_id, 'payment_id', p_payment_id,
      'persisted', false, 'skipped', true,
      'reason', 'ADMIN_OVERRIDE_LOCK'
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

  -- Advance the booking only when the human lock is absent AND the total did not
  -- move underneath the scan. `v_booking_status` is already a valid enum member.
  if not v_total_drift then
    update public.bookings
       set payment_status = v_booking_status,
           ocr_metadata = coalesce(p_ocr_metadata, ocr_metadata),
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
    'stale_total', v_total_drift,
    'booking_payment_status', v_booking_status::text
  );
end;
$$;

comment on function public.persist_ocr_result(uuid, uuid, numeric, text, text, jsonb) is
  'Records the OCR verdict. Normalises and validates p_payment_status against the booking_payment_status enum before casting, so text->enum can never raise 42804 again; maps payment-level verdicts (FOR_VERIFICATION/REJECTED) onto booking states and keeps the raw verdict in ocr_metadata. Refuses to overwrite a human override and refuses a stale verdict.';

revoke all on function public.persist_ocr_result(uuid, uuid, numeric, text, text, jsonb) from public;
grant execute on function public.persist_ocr_result(uuid, uuid, numeric, text, text, jsonb) to service_role;