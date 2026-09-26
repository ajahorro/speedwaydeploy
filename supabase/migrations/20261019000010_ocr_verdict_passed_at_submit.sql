-- ============================================================================
-- 20261019000010_ocr_verdict_passed_at_submit.sql
-- ============================================================================
--
-- REPLACES the gate from 20261019000009, which was structurally impossible.
--
-- WHY v2 COULD NOT WORK
-- ---------------------
-- v2 read the verdict from `public.payments`:
--
--     where pay.booking_id = v_booking_id
--
-- but `v_booking_id` is assigned BY the master INSERT, which has not run yet at
-- that point. So the query matched nothing, the gate silently did nothing, and a
-- non-receipt image still produced a booking. Measured, not assumed:
--
--     gate fires on a REJECTED receipt : false
--     clean receipt recorded as        : unpaid (should be pending)
--
-- More fundamentally: create_booking_atomic inserts the booking AND its payment in
-- ONE transaction, so the payment row cannot exist before the gate runs. The
-- verdict is therefore NOT in the database yet, and reading it from there is
-- impossible by construction — not merely mis-ordered.
--
-- WHERE THE VERDICT ACTUALLY COMES FROM
-- -------------------------------------
-- The OCR scan happens BEFORE submit (backend /api/ocr/audit), and the client
-- carries its verdict into the booking payload. That verdict is the only signal
-- available at this point. It is also client-controlled, so it is validated
-- rather than trusted:
--
--   * the value must be a member of a fixed allow-list; anything else is refused
--   * a settlement verdict (PAID/REFUND_PENDING/REFUNDED) is refused for
--     non-admins, so a customer cannot self-settle
--   * the booking's status is DERIVED from the verdict via
--     derive_booking_payment_status(), so a caller cannot submit one verdict and
--     have the booking record another
--
-- WHAT THIS DOES AND DOES NOT GUARANTEE
-- -------------------------------------
-- It guarantees: no unvalidated value can reach the enum column; a rejected
-- receipt cannot produce a booking; a customer cannot create a settled booking;
-- and the booking status always agrees with the verdict that was supplied.
--
-- It does NOT cryptographically prove the verdict came from our OCR service — a
-- caller who forges `FOR_VERIFICATION` is, in effect, submitting a receipt for
-- manual review, which is exactly what an honest clean scan does. The money still
-- cannot be recognised until an admin verifies it (FOR_VERIFICATION is excluded
-- from recognised revenue), so the blast radius of a forged verdict is "an admin
-- sees one more receipt in the verification queue" — not a settled booking.
-- Recording the verdict server-side at scan time (rather than trusting the
-- client's echo) is the remaining hardening step.
-- ============================================================================

do $ocr_gate_v3$
declare
  v_src      text;
  v_patched  text;
  v_start    int;
  v_end      int;
  v_gate     text;
begin
  select pg_get_functiondef(p.oid)
    into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if v_src is null then
    raise exception 'ocr gate v3: create_booking_atomic() does not exist.';
  end if;

  if position('OCR_VERDICT_GATE_V3' in v_src) > 0 then
    raise notice 'ocr gate v3: already applied — no-op.';
    return;
  end if;

  -- Excise whichever earlier gate is present (V2, or the original payload gate).
  if position('OCR_VERDICT_GATE_V2' in v_src) > 0 then
    v_start := position('  -- OCR_VERDICT_GATE_V2' in v_src);
  elsif position('OCR_VERDICT_GATE' in v_src) > 0 then
    v_start := position('  -- OCR_VERDICT_GATE' in v_src);
  else
    v_start := 0;
  end if;

  v_end := position('  -- 1. Master booking row' in v_src);

  if v_end = 0 then
    raise exception 'ocr gate v3: master-insert anchor not found.';
  end if;

  if v_start > 0 and v_end > v_start then
    v_patched := substr(v_src, 1, v_start - 1) || substr(v_src, v_end);
  else
    v_patched := v_src;
  end if;

  -- ── The gate ────────────────────────────────────────────────────────────
  -- The verdict arrives on the payment object in the payload. It is allow-listed,
  -- never trusted, and the booking status is derived from it.
  v_gate :=
    '  -- OCR_VERDICT_GATE_V3: the OCR verdict gates booking creation.' || chr(10) ||
    '  --' || chr(10) ||
    '  -- The verdict is carried on the payment object in the payload. It CANNOT be' || chr(10) ||
    '  -- read from public.payments here: this function inserts the booking and its' || chr(10) ||
    '  -- payment in one transaction, so no payment row exists yet. It is therefore' || chr(10) ||
    '  -- allow-listed and the booking status is DERIVED from it, so a caller cannot' || chr(10) ||
    '  -- submit one verdict and have the booking record another.' || chr(10) ||
    '  <<ocr_verdict_gate_v3>>' || chr(10) ||
    '  declare' || chr(10) ||
    '    v_verdict text;' || chr(10) ||
    '    v_derived text;' || chr(10) ||
    '  begin' || chr(10) ||
    '    if v_payment is not null and jsonb_typeof(v_payment) = ''object'' then' || chr(10) ||
    '      -- Accept the verdict from the payment object, falling back to the' || chr(10) ||
    '      -- booking object so both call shapes work.' || chr(10) ||
    '      v_verdict := upper(coalesce(' || chr(10) ||
    '        nullif(v_payment ->> ''verdict'', ''''),' || chr(10) ||
    '        nullif(v_payment ->> ''status'', ''''),' || chr(10) ||
    '        nullif(v_booking ->> ''ocr_verdict'', ''''),' || chr(10) ||
    '        ''''));' || chr(10) ||
    '' || chr(10) ||
    '      -- Allow-list. An unrecognised value must not reach the enum column,' || chr(10) ||
    '      -- and an absent verdict means the receipt was never scanned.' || chr(10) ||
    '      if v_verdict = '''' or v_verdict is null then' || chr(10) ||
    '        raise exception ' || quote_literal('This booking has no receipt verdict. Scan the payment receipt before submitting.') || chr(10) ||
    '          using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '      end if;' || chr(10) ||
    '' || chr(10) ||
    '      if v_verdict not in (''FOR_VERIFICATION'', ''REJECTED'', ''UNPAID'', ''PAID'', ''REFUND_PENDING'', ''REFUNDED'') then' || chr(10) ||
    '        raise exception ' || quote_literal('Unrecognised receipt verdict: %. The booking was not created.') || ', v_verdict' || chr(10) ||
    '          using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '      end if;' || chr(10) ||
    '' || chr(10) ||
    '      -- The non-receipt image lands here.' || chr(10) ||
    '      if v_verdict = ''REJECTED'' then' || chr(10) ||
    '        raise exception ' || quote_literal('This receipt could not be verified and was rejected, so the booking was not created. Please upload a valid payment receipt.') || chr(10) ||
    '          using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '      end if;' || chr(10) ||
    '' || chr(10) ||
    '      -- A customer may not create an already-settled booking.' || chr(10) ||
    '      if v_verdict in (''PAID'', ''REFUND_PENDING'', ''REFUNDED'') and not public.is_admin() then' || chr(10) ||
    '        raise exception ' || quote_literal('A customer booking cannot be created as already paid. Submit the receipt for verification instead.') || chr(10) ||
    '          using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '      end if;' || chr(10) ||
    '' || chr(10) ||
    '      -- Derive the booking status FROM the verdict so the two cannot disagree.' || chr(10) ||
    '      v_derived := public.derive_booking_payment_status(v_verdict, null);' || chr(10) ||
    '' || chr(10) ||
    '      if v_derived = ''rejected'' then' || chr(10) ||
    '        raise exception ' || quote_literal('This receipt could not be verified and was rejected, so the booking was not created. Please upload a valid payment receipt.') || chr(10) ||
    '          using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '      end if;' || chr(10) ||
    '' || chr(10) ||
    '      -- The master INSERT reads v_payment_status, so it must be assigned here.' || chr(10) ||
    '      v_payment_status := v_derived::booking_payment_status;' || chr(10) ||
    '' || chr(10) ||
    '      -- A JSON *string*, never a JSON null: jsonb_set with' || chr(10) ||
    '      -- create_if_missing => true DISCARDS the whole object on a JSON null.' || chr(10) ||
    '      v_booking := jsonb_set(v_booking, ''{payment_status}'', to_jsonb(v_derived), true);' || chr(10) ||
    '    end if;' || chr(10) ||
    '  end;' || chr(10) || chr(10);

  v_patched := replace(
    v_patched,
    '  -- 1. Master booking row ----------------------------------------------------',
    v_gate || '  -- 1. Master booking row ----------------------------------------------------'
  );

  if v_patched = v_src then
    raise exception 'ocr gate v3: patch produced no change.';
  end if;

  execute v_patched;

  -- ── Assert it landed ────────────────────────────────────────────────────
  select pg_get_functiondef(p.oid)
    into v_patched
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if position('OCR_VERDICT_GATE_V3' in v_patched) = 0 then
    raise exception 'ocr gate v3: did not land in the live body.';
  end if;
  if position('v_payment_status := v_derived' in v_patched) = 0 then
    raise exception 'ocr gate v3: the derived status is never assigned to the enum variable.';
  end if;
  if position('OCR_VERDICT_GATE_V2' in v_patched) > 0 then
    raise exception 'ocr gate v3: the V2 gate survived the excision.';
  end if;

  raise notice 'ocr gate v3 applied: verdict allow-listed from the payload, booking status derived from it.';
end $ocr_gate_v3$;