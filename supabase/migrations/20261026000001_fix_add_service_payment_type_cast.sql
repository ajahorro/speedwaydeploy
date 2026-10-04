-- ============================================================================
-- Admin "add service" failed with HTTP 500:
--   column "payment_type" is of type payment_type_enum but expression is of type text
--
-- mutate_booking_locked() inserted p_payment ->> 'payment_type' (text) straight
-- into payments.payment_type (payment_type_enum: Full, Downpayment, Manual).
-- create_booking_atomic already normalizes it with initcap() and a cast; this
-- applies the same rule here. The function is patched in place from its live
-- definition so nothing else in it changes.
-- ============================================================================
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'mutate_booking_locked';

  if v_def is null then
    raise notice 'mutate_booking_locked() not found; nothing to patch.';
    return;
  end if;

  v_new := replace(
    v_def,
    'p_payment ->> ''payment_type'',',
    'nullif(initcap(coalesce(p_payment ->> ''payment_type'', '''')), '''')::public.payment_type_enum,'
  );

  if v_new = v_def then
    raise notice 'mutate_booking_locked() already patched.';
    return;
  end if;

  execute v_new;
end $$;
