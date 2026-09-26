-- ============================================================================
-- 20261019000009_ocr_verdict_gate_from_payments.sql
-- ============================================================================
--
-- REPLACES the gate installed by 20261019000008.
--
-- WHAT WAS WRONG WITH THE FIRST ATTEMPT
-- -------------------------------------
-- 20261019000008 added an OCR verdict gate to create_booking_atomic, but read the
-- verdict from `v_payment` — which is `p_payload -> 'payment'`, the CLIENT'S
-- REQUEST BODY. Verified against the live function:
--
--     OCR_VERDICT_GATE present : true
--     reads client payload     : true      <-- the problem
--     reads from payments      : false
--
-- Reading the verdict from the payload is self-defeating. The entire reason the
-- gate exists is that the client's claim about its own receipt cannot be trusted;
-- a caller that omits `status` (or sends FOR_VERIFICATION) satisfies the gate
-- while the database may hold a REJECTED verdict. The gate was also ineffective
-- in practice because the client never sends `ocr_metadata` in the payload at all
-- — so the reason was always empty and the REJECTED branch could never fire.
--
-- A second consequence: a clean customer receipt was recorded as `unpaid` rather
-- than `pending`, so it never appeared in the verification queue.
--
-- THE CORRECTION
-- --------------
-- Read the verdict from the DATABASE — `public.payments.status` joined to
-- `public.bookings.ocr_metadata` for the reason — because that is where the OCR
-- pipeline actually writes it. Then:
--
--   * REJECTED  -> refuse the booking outright (no row written)
--   * PAID      -> refuse for a non-admin (a customer may not self-settle)
--   * FOR_VERIFICATION -> record the booking as 'pending', so the portal shows it
--                         in the verification queue instead of as unpaid
--
-- Also asserts `v_payment_status` is set, because the master INSERT reads that
-- variable (not the jsonb) for the enum column — without it the gate would change
-- nothing observable.
--
-- IDEMPOTENT: detects the payload-based version and replaces it; a second run is
-- a no-op.
-- ============================================================================

do $replace_gate$
declare
  v_src        text;
  v_old_gate   text;
  v_new_gate   text;
  v_patched    text;
  v_start      int;
  v_end        int;
  v_body       text;
begin
  select pg_get_functiondef(p.oid)
    into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if v_src is null then
    raise exception 'ocr verdict gate (v2): create_booking_atomic() does not exist.';
  end if;

  if position('OCR_VERDICT_GATE_V2' in v_src) > 0 then
    raise notice 'ocr verdict gate (v2): already applied — no-op.';
    return;
  end if;

  -- ── Excise the old payload-based gate ───────────────────────────────────
  -- It spans from its marker comment to the matching `end;` before the master
  -- INSERT comment. We locate the marker and the INSERT anchor, then rebuild.
  if position('OCR_VERDICT_GATE' in v_src) > 0 then
    v_start := position('  -- OCR_VERDICT_GATE' in v_src);
    v_end := position('  -- 1. Master booking row' in v_src);

    if v_start = 0 or v_end = 0 or v_end <= v_start then
      raise exception 'ocr verdict gate (v2): could not locate the old gate boundaries.';
    end if;

    -- Keep everything before the old gate, and everything from the INSERT anchor.
    v_patched := substr(v_src, 1, v_start - 1) || substr(v_src, v_end);
  else
    v_patched := v_src;
  end if;

  -- ── Install the payments-backed gate ────────────────────────────────────
  v_new_gate :=
    '  -- OCR_VERDICT_GATE_V2: the stored OCR verdict is authoritative.' || chr(10) ||
    '  --' || chr(10) ||
    '  -- The verdict is read from public.payments — NOT from v_payment, which is' || chr(10) ||
    '  -- the untrusted client payload. The OCR pipeline writes the verdict to the' || chr(10) ||
    '  -- database, so the database is the only trustworthy source. Reading it from' || chr(10) ||
    '  -- the payload would let a caller omit the field and satisfy the gate.' || chr(10) ||
    '  <<ocr_verdict_gate>>' || chr(10) ||
    '  declare' || chr(10) ||
    '    v_verdict_status text;' || chr(10) ||
    '    v_verdict_reason text;' || chr(10) ||
    '    v_derived_status text;' || chr(10) ||
    '    v_has_payment    boolean;' || chr(10) ||
    '  begin' || chr(10) ||
    '    -- Latest payment for this booking, plus the booking''s OCR metadata.' || chr(10) ||
    '    select upper(coalesce(pay.status, '''')),' || chr(10) ||
    '           upper(coalesce(bk.ocr_metadata ->> ''payment_verdict'', ''''))' || chr(10) ||
    '      into v_verdict_status, v_verdict_reason' || chr(10) ||
    '      from public.payments pay' || chr(10) ||
    '      left join public.bookings bk on bk.id = pay.booking_id' || chr(10) ||
    '     where pay.booking_id = v_booking_id' || chr(10) ||
    '     order by pay.created_at desc' || chr(10) ||
    '     limit 1;' || chr(10) ||
    '' || chr(10) ||
    '    v_has_payment := v_verdict_status is not null and v_verdict_status <> '''';' || chr(10) ||
    '' || chr(10) ||
    '    if v_has_payment then' || chr(10) ||
    '      -- A REJECTED verdict means the image was not a usable receipt (or was a' || chr(10) ||
    '      -- duplicate / mismatched). Nothing legitimate can be booked against it.' || chr(10) ||
    '      if v_verdict_status = ''REJECTED'' or v_verdict_reason = ''REJECTED'' then' || chr(10) ||
    '        raise exception ' || quote_literal('This receipt could not be verified and was rejected, so the booking was not created. Please upload a valid payment receipt.') || chr(10) ||
    '          using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '      end if;' || chr(10) ||
    '' || chr(10) ||
    '      -- A customer may not assert a settled booking on their own authority.' || chr(10) ||
    '      if v_verdict_status in (''PAID'', ''REFUND_PENDING'', ''REFUNDED'')' || chr(10) ||
    '         and not public.is_admin() then' || chr(10) ||
    '        raise exception ' || quote_literal('A customer booking cannot be created as already paid. Submit the receipt for verification instead.') || chr(10) ||
    '          using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '      end if;' || chr(10) ||
    '' || chr(10) ||
    '      v_derived_status := public.derive_booking_payment_status(v_verdict_status, v_verdict_reason);' || chr(10) ||
    '' || chr(10) ||
    '      if v_derived_status = ''rejected'' then' || chr(10) ||
    '        raise exception ' || quote_literal('This receipt could not be verified and was rejected, so the booking was not created. Please upload a valid payment receipt.') || chr(10) ||
    '          using errcode = ' || quote_literal('check_violation') || ';' || chr(10) ||
    '      end if;' || chr(10) ||
    '' || chr(10) ||
    '      if v_derived_status is not null and v_derived_status <> '''' then' || chr(10) ||
    '        -- The master INSERT reads v_payment_status for the enum column, so it' || chr(10) ||
    '        -- MUST be set here or the gate would change nothing observable.' || chr(10) ||
    '        v_payment_status := v_derived_status::booking_payment_status;' || chr(10) ||
    '' || chr(10) ||
    '        -- A JSON *string*, never a JSON null: jsonb_set with' || chr(10) ||
    '        -- create_if_missing => true DISCARDS the whole object on a JSON null,' || chr(10) ||
    '        -- which is the defect that previously NULLed total_amount and schedule.' || chr(10) ||
    '        v_booking := jsonb_set(v_booking, ''{payment_status}'', to_jsonb(v_derived_status), true);' || chr(10) ||
    '      end if;' || chr(10) ||
    '    end if;' || chr(10) ||
    '  end;' || chr(10) || chr(10);

  v_patched := replace(
    v_patched,
    '  -- 1. Master booking row ----------------------------------------------------',
    v_new_gate || '  -- 1. Master booking row ----------------------------------------------------'
  );

  if v_patched = v_src then
    raise exception 'ocr verdict gate (v2): patch produced no change — refusing a no-op migration.';
  end if;

  execute v_patched;

  -- ── Assert the replacement landed ───────────────────────────────────────
  select pg_get_functiondef(p.oid)
    into v_patched
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if position('OCR_VERDICT_GATE_V2' in v_patched) = 0 then
    raise exception 'ocr verdict gate (v2): did not land in the live body.';
  end if;

  if position('from public.payments pay' in v_patched) = 0 then
    raise exception 'ocr verdict gate (v2): the payments lookup did not land.';
  end if;

  if position('v_payment_status := v_derived_status' in v_patched) = 0 then
    raise exception 'ocr verdict gate (v2): the derived status is never assigned to the enum variable.';
  end if;

  if position('v_payment -> ''ocr_metadata''' in v_patched) > 0 then
    raise exception 'ocr verdict gate (v2): the old payload read survived the excision.';
  end if;

  raise notice 'ocr verdict gate (v2) applied: verdict now read from public.payments.';
end $replace_gate$;