-- A customer who chooses Cash is only promising to pay at the shop: the payment is recorded as PENDING and the booking
-- as unpaid. The receipt-verdict gate in create_booking_atomic did not know the verdict PENDING, so every customer
-- cash booking was refused with "Unrecognised receipt verdict: PENDING". PENDING is accepted for a cash payment only.
do $patch$
declare
  v_def text;
  v_old text := E'      if v_verdict not in (''FOR_VERIFICATION'', ''REJECTED'', ''UNPAID'', ''PAID'', ''REFUND_PENDING'', ''REFUNDED'') then';
  v_new text := E'      if v_verdict = ''PENDING'' and upper(coalesce(v_payment ->> ''method'', '''')) = ''CASH'' then\n        v_verdict := ''UNPAID'';\n      end if;\n\n' || E'      if v_verdict not in (''FOR_VERIFICATION'', ''REJECTED'', ''UNPAID'', ''PAID'', ''REFUND_PENDING'', ''REFUNDED'') then';
begin
  select pg_get_functiondef('public.create_booking_atomic(jsonb)'::regprocedure) into v_def;
  if position('v_verdict := ''UNPAID''' in v_def) > 0 then return; end if;
  v_def := replace(v_def, v_old, v_new);
  if position('v_verdict := ''UNPAID''' in v_def) = 0 then
    raise exception 'create_booking_atomic layout changed; cash patch not installed';
  end if;
  execute v_def;
end
$patch$;
