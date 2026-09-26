-- ============================================================================
-- 20261019000008_ocr_verdict_is_authoritative.sql
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Reported: "the OCR is supposed to be strict and a source of truth, however,
-- someone managed to send a non-receipt image and their booking went through."
--
-- Three independent defects combined to produce that, and this migration closes
-- the one that lives in the database:
--
--   1. (backend/server.js) The OCR verdict was assigned to bookings.payment_status
--      as human-readable text ('Flagged for Review' / 'Confirmed') against a
--      `booking_payment_status` ENUM. The cast raised 42804, and the handler only
--      LOGGED it — the endpoint still returned success. Fixed in the backend.
--
--   2. (backend/server.js) When no booking row existed yet (the pre-submit scan),
--      the call to persist_ocr_result was skipped entirely — so the single call
--      that records the verdict never ran. Fixed in the backend.
--
--   3. (here) Nothing in the DATABASE required the stored verdict to agree with
--      the booking. create_booking_atomic accepted whatever the client sent as
--      `payment_status`, so a client that had scanned a napkin could still submit
--      `payment_status: 'pending'` (or omit it) and the booking was created.
--
-- THE FIX
-- -------
-- Make the OCR verdict authoritative AT COMMIT TIME. create_booking_atomic now
-- re-derives the booking's payment_status from the stored payment verdict rather
-- than trusting the payload:
--
--   * A customer booking with a payment must have that payment in
--     FOR_VERIFICATION. It can NEVER be created as 'paid'.
--   * A payment in REJECTED (the non-receipt / mismatch / duplicate verdict) is
--     refused outright — no booking row is written.
--   * No payment at all keeps the existing unpaid behaviour.
--
-- WHY THE RE-DERIVATION RATHER THAN A VALIDATION
-- ----------------------------------------------
-- Validating the submitted value fixes the honest case and nothing else: the
-- payload is client-controlled, so a caller can simply claim a value the check
-- accepts. Deriving the status from the payment row that OCR actually wrote means
-- the client's opinion of its own receipt no longer matters. The database decides.
--
-- The OCR verdicts are read from `payments.status` (the payment_status enum:
-- UNPAID | FOR_VERIFICATION | PAID | REJECTED | REFUND_PENDING | REFUNDED) and,
-- for the reason, from `payments.ocr_metadata->>'payment_verdict'` — the backend
-- records the payment-level verdict there because bookings.payment_status has no
-- member for it.
-- ============================================================================

create or replace function public.derive_booking_payment_status(
  p_payment_status text,
  p_payment_verdict text default null
)
returns text
language sql
immutable
as $$
  select case
    -- A settled payment is the only path to a 'paid' booking.
    when upper(coalesce(p_payment_status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED')
      then 'paid'
    -- A rejected receipt must never produce a bookable booking.
    when upper(coalesce(p_payment_status, '')) = 'REJECTED'
      or upper(coalesce(p_payment_verdict, '')) = 'REJECTED'
      then 'rejected'
    -- A receipt awaiting a human decision. bookings.payment_status spells this
    -- 'pending'; it has NO 'for_verification' member.
    when upper(coalesce(p_payment_status, '')) = 'FOR_VERIFICATION'
      then 'pending'
    else 'unpaid'
  end;
$$;

comment on function public.derive_booking_payment_status(text, text) is
  'Maps a payment-level OCR verdict onto bookings.payment_status (the only four members: unpaid|pending|paid|refunded). Single source of truth so the backend and create_booking_atomic cannot disagree about what a verdict means.';

revoke all on function public.derive_booking_payment_status(text, text) from public;
grant execute on function public.derive_booking_payment_status(text, text) to authenticated;


-- ── Enforce the verdict inside create_booking_atomic ────────────────────────
do $ocr_gate$
declare
  v_src     text;
  v_patched text;
begin
  select pg_get_functiondef(p.oid)
    into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if v_src is null then
    raise exception 'ocr verdict gate: public.create_booking_atomic() does not exist.';
  end if;

  if position('OCR_VERDICT_GATE' in v_src) > 0 then
    -- The first attempt at this gate was applied from the client payload and had
    -- to be replaced with the payments-backed version. Detect that older shape and
    -- refuse, so a half-upgraded database cannot look "already applied".
    if position('v_payment -> ''ocr_metadata''' in v_src) > 0 then
      raise exception 'ocr verdict gate: an OLDER, payload-based gate is present. It reads the verdict from the untrusted client payload. Replace it before proceeding.';
    end if;
    raise notice 'ocr verdict gate: already applied — no-op.';
    return;
  end if;

  -- The gate runs LAST, immediately before the master INSERT, so every other
  -- integrity check has already passed and this one has the final word.
  --
  -- WHERE THE VERDICT IS READ FROM — this is subtle and was wrong at first.
  --
  -- `v_payment` is `p_payload -> 'payment'`: the CLIENT's request body. It cannot
  -- be trusted (that is the whole point), and the OCR verdict is not in it anyway:
  -- the verdict is written to the DATABASE by the backend's OCR pipeline, onto
  -- the payment row that was created by an EARLIER call.
  --
  -- So the gate joins public.payments on this booking's latest row and reads the
  -- stored verdict there. That is what makes the check authoritative — it
  -- inspects what actually happened, not what the client claims happened.
  --
  -- STRUCTURE NOTE: plpgsql does not allow DECLARE inside a control-flow block,
  -- so the variables live in a labelled sub-block whose DECLARE comes first.
  v_patched := replace(
    v_src,
    '  -- 1. Master booking row ----------------------------------------------------',
    '  -- OCR_VERDICT_GATE: the stored OCR verdict is authoritative at commit time.' || chr(10) ||
    '  --' || chr(10) ||
    '  -- Read from public.payments, NOT from v_payment (the client payload). The' || chr(10) ||
    '  -- verdict is written to the database by the OCR pipeline, so the database is' || chr(10) ||
    '  -- the only trustworthy source. A non-receipt image leaves a REJECTED verdict' || chr(10) ||
    '  -- there, and this gate refuses the booking outright.' || chr(10) ||
    '  <<ocr_verdict_gate>>' || chr(10) ||
    '  declare' || chr(10) ||
    '    v_verdict_status text;' || chr(10) ||
    '    v_verdict_reason text;' || chr(10) ||
    '    v_derived_status text;' || chr(10) ||
    '  begin' || chr(10) ||
    '    -- The most recent payment for this booking.' || chr(10) ||
    '    select upper(coalesce(pay.status, '''')),' || chr(10) ||
    '           upper(coalesce(bk.ocr_metadata ->> ''payment_verdict'', ''''))' || chr(10) ||
    '      into v_verdict_status, v_verdict_reason' || chr(10) ||
    '      from public.payments pay' || chr(10) ||
    '      left join public.bookings bk on bk.id = pay.booking_id' || chr(10) ||
    '     where pay.booking_id = v_booking_id' || chr(10) ||
    '     order by pay.created_at desc' || chr(10) ||
    '     limit 1;' || chr(10) ||
    '' || chr(10) ||
    '    -- A REJECTED verdict means the image was not a usable receipt (or was a' || chr(10) ||
    '    -- duplicate / mismatched). There is nothing legitimate to book against.' || chr(10) ||
    '    if v_verdict_status = ''REJECTED'' or v_verdict_reason = ''REJECTED'' then' || chr(10) ||
    '      raise exception ' || quote_literal('This receipt could not be verified and was rejected, so the booking was not created. Please upload a valid payment receipt.') || chr(10) ||
    '        using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '    end if;' || chr(10) ||
    '' || chr(10) ||
    '    -- A customer may not assert a settled booking on their own authority.' || chr(10) ||
    '    if v_verdict_status in (''PAID'', ''REFUND_PENDING'', ''REFUNDED'')' || chr(10) ||
    '       and not public.is_admin() then' || chr(10) ||
    '      raise exception ' || quote_literal('A customer booking cannot be created as already paid. Submit the receipt for verification instead.') || chr(10) ||
    '        using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '    end if;' || chr(10) ||
    '' || chr(10) ||
    '    -- A receipt awaiting a human decision must be recorded as such, so the' || chr(10) ||
    '    -- portal shows it in the verification queue instead of reading as unpaid.' || chr(10) ||
    '    -- The client''s own payment_status is overridden, never trusted.' || chr(10) ||
    '    v_derived_status := public.derive_booking_payment_status(v_verdict_status, v_verdict_reason);' || chr(10) ||
    '' || chr(10) ||
    '    if v_derived_status = ''rejected'' then' || chr(10) ||
    '      raise exception ' || quote_literal('This receipt could not be verified and was rejected, so the booking was not created. Please upload a valid payment receipt.') || chr(10) ||
    '        using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '    end if;' || chr(10) ||
    '' || chr(10) ||
    '    if v_derived_status is not null and v_derived_status <> '''' then' || chr(10) ||
    '      -- NOTE: a JSON *string*, never a JSON null. Writing a JSON null into' || chr(10) ||
    '      -- jsonb_set with create_if_missing => true DISCARDS the whole object,' || chr(10) ||
    '      -- which is the defect that previously NULLed total_amount and the' || chr(10) ||
    '      -- schedule on every guest booking.' || chr(10) ||
    '      v_booking := jsonb_set(v_booking, ''{payment_status}'', to_jsonb(v_derived_status), true);' || chr(10) ||
    '      v_payment_status := v_derived_status::booking_payment_status;' || chr(10) ||
    '    end if;' || chr(10) ||
    '  end;' || chr(10) || chr(10) ||
    '  -- 1. Master booking row ----------------------------------------------------'
  );

  if v_patched = v_src then
    raise exception 'ocr verdict gate: anchor not found — refusing to record a no-op migration.';
  end if;

  execute v_patched;

  -- Assert the gate really landed.
  select pg_get_functiondef(p.oid)
    into v_patched
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if position('OCR_VERDICT_GATE' in v_patched) = 0 then
    raise exception 'ocr verdict gate: did not land in the live function body.';
  end if;

  raise notice 'ocr verdict gate applied: create_booking_atomic() now derives payment_status from the stored OCR verdict.';
end $ocr_gate$;


-- ── Make the rejected verdict queryable for the UI ──────────────────────────
-- A customer whose receipt was rejected needs to be told, and an admin needs to
-- see it. The verdict is stored in TWO places, because the two tables differ:
--
--   payments.status                  -> the payment-level verdict enum
--                                      (UNPAID|FOR_VERIFICATION|PAID|REJECTED|...)
--   bookings.ocr_metadata            -> the rich JSON detail (isValidReceipt,
--                                      isAmountMatch, isDateMatch, reason, ...)
--   payments.ocr_text                -> the raw OCR text
--
-- NOTE: `payments` has NO `ocr_metadata` column — that is a bookings column. An
-- earlier draft of this function read payments.ocr_metadata and failed with
--   42703: column p.ocr_metadata does not exist
-- which is why this function joins the booking for the JSON detail instead of
-- assuming the payment carries it.
create or replace function public.payment_ocr_verdict(p_payment_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'payment_id', p.id,
    'booking_id', p.booking_id,
    'payment_status', upper(coalesce(p.status, '')),
    -- The payment-level verdict the backend records. Read from the BOOKING's
    -- ocr_metadata, with a fallback to the payments.status enum so a verdict is
    -- still reported if the JSON write did not happen.
    'verdict', coalesce(
      nullif(upper(coalesce(b.ocr_metadata ->> 'payment_verdict', '')), ''),
      case
        when upper(coalesce(p.status, '')) = 'REJECTED' then 'REJECTED'
        when upper(coalesce(p.status, '')) = 'FOR_VERIFICATION' then 'FOR_VERIFICATION'
        else upper(coalesce(p.status, ''))
      end
    ),
    'is_trustworthy', coalesce((b.ocr_metadata ->> 'receipt_is_trustworthy')::boolean, false),
    'is_valid_receipt', coalesce((b.ocr_metadata ->> 'isValidReceipt')::boolean, false),
    'amount_match', coalesce((b.ocr_metadata ->> 'isAmountMatch')::boolean, false),
    'date_match', coalesce((b.ocr_metadata ->> 'isDateMatch')::boolean, false),
    'is_duplicate', coalesce((b.ocr_metadata ->> 'isDuplicate')::boolean, false),
    'duplicate_reason', b.ocr_metadata ->> 'duplicate_reason',
    'detected_amount', p.detected_amount,
    'detected_ref', p.detected_ref,
    'ocr_text', p.ocr_text,
    'rejection_reason', p.rejection_reason,
    'ocr_reason', b.ocr_metadata ->> 'reason'
  )
  from public.payments p
  left join public.bookings b on b.id = p.booking_id
 where p.id = p_payment_id;
$$;

comment on function public.payment_ocr_verdict(uuid) is
  'The OCR verdict for a payment in one object (status, whether the receipt was trusted, and why it failed). Read-only; lets the UI and admin surfaces explain a rejection without hard-coding the ocr_metadata JSON paths.';

revoke all on function public.payment_ocr_verdict(uuid) from public;
grant execute on function public.payment_ocr_verdict(uuid) to authenticated;