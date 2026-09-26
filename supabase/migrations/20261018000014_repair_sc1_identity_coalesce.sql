-- ============================================================================
-- 20261018000014_repair_sc1_identity_coalesce.sql
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- 20261018000003_identity_capacity_ocr_race.sql patches create_booking_atomic()
-- to resolve a guest booking's `customer_id` from its email. As PUBLISHED it
-- generated this expression into the live function body:
--
--     to_jsonb(coalesce(v_booking ->> 'customer_id',
--                       public.resolve_customer_by_email(v_booking ->> 'customer_email')))
--
-- `v_booking ->> 'customer_id'` is TEXT and resolve_customer_by_email() returns
-- UUID, so the COALESCE has no common type. Every booking submit therefore died
-- at the master insert with:
--
--     COALESCE types text and uuid cannot be matched   (SQLSTATE 42804)
--
-- This is a SECOND, independent defect from the payment_status text->enum crash
-- fixed by 20261016000001..4: that one blocked the insert one line earlier, so
-- it masked this one. Removing the first crash exposed the second.
--
-- WHY A LEDGER REPAIR AND NOT A RE-PUSH
-- -------------------------------------
-- 20261018000003 is already recorded as applied, and `supabase db push` skips
-- recorded versions — editing the file in place changes nothing for a database
-- that has already run it. Migration files are immutable once applied; a
-- correction is a NEW versioned migration. This is that correction.
--
-- THE FIX
-- -------
-- Rewrite ONLY the bad expression, in place, and leave the rest of the function
-- byte-identical. The corrected call returns a nullable UUID directly:
--
--     to_jsonb(public.resolve_customer_by_email(v_booking ->> 'customer_email'))
--
-- NULL is the correct outcome for an email with no matching profile: jsonb_set
-- happily stores a JSON null, and the master insert reads the field as
-- `nullif(v_booking ->> 'customer_id', '')::uuid`, so an unresolved email stays
-- a guest booking rather than aborting the transaction.
--
-- IDEMPOTENT: the "bad" fragment is assembled at runtime from quote_literal()
-- pieces and the string quote_literal(''), so it matches the body produced by
-- the buggy migration only — never the corrected text this migration produces.
-- Re-running is a clean no-op.
-- ============================================================================

do $repair$
declare
  v_src     text;
  v_patched text;
  v_bad     text;
  v_good    text;
begin
  -- quote_literal('') renders as the two-character string '' when spliced.
  -- Building the fragments from primitives (quote_literal('') for the empty
  -- string, chr(39) for a single quote) keeps this file independent of quote
  -- doubling, which is what broke the migration being repaired.
  v_bad := 'coalesce(v_booking ->> ' || quote_literal('customer_id')
           || ', public.resolve_customer_by_email(v_booking ->> '
           || quote_literal('customer_email') || '))';

  v_good := 'public.resolve_customer_by_email(v_booking ->> '
            || quote_literal('customer_email') || ')';

  select pg_get_functiondef(p.oid)
    into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if v_src is null then
    raise exception 'SC-1 repair: public.create_booking_atomic() does not exist. Apply 20261001000001 first.';
  end if;

  if position(v_bad in v_src) = 0 then
    if position('resolve_customer_by_email' in v_src) > 0 then
      raise notice 'SC-1 repair: live body already uses the corrected uuid expression — no-op.';
    else
      raise notice 'SC-1 repair: identity patch not present in the live body — no-op.';
    end if;
    return;
  end if;

  v_patched := replace(v_src, v_bad, v_good);

  if v_patched = v_src then
    raise exception 'SC-1 repair: replace() did not modify the function body.';
  end if;

  execute v_patched;

  -- Re-read and assert, so the migration cannot record success without the
  -- repair actually landing (the failure mode that let the original bug ship).
  select pg_get_functiondef(p.oid)
    into v_patched
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if position(v_bad in v_patched) > 0 then
    raise exception 'SC-1 repair: the uuid/text COALESCE is STILL in the live body after replacement.';
  end if;

  if position('resolve_customer_by_email' in v_patched) = 0 then
    raise exception 'SC-1 repair: identity resolution disappeared from the live body; aborting.';
  end if;

  raise notice 'SC-1 repair applied: uuid/text COALESCE removed from create_booking_atomic().';
end $repair$;