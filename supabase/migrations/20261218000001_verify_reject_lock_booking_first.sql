-- Verifying or rejecting a payment while the same booking is being cancelled could deadlock:
--   admin_cancel_booking locks the booking row, then its payments;
--   admin_verify_payment / admin_reject_payment locked the payment row, then (through the audit trigger) the booking row.
-- Postgres ended the deadlock by cancelling one of them, so money stayed correct, but that caller got a 500.
-- Every function that touches both now takes the locks in the same order: booking first, then payment.

do $patch$
declare
  v_fn text;
  v_def text;
  v_new text;
begin
  foreach v_fn in array array['public.admin_verify_payment(uuid,uuid,numeric,text,boolean)', 'public.admin_reject_payment(uuid,uuid,text,boolean,text)']
  loop
    select pg_get_functiondef(v_fn::regprocedure) into v_def;
    if v_def not like '%perform 1 from public.bookings where id = p_booking_id for update%' then
      v_new := regexp_replace(
        v_def,
        E'(  select (upper\\(coalesce\\(status|\\* into v_payment))',
        E'  -- lock order: booking first, then payment (the same order admin_cancel_booking uses)\n  perform 1 from public.bookings where id = p_booking_id for update;\n\n  \\1'
      );
      if v_new = v_def then raise exception '% layout changed; patch not applied', v_fn; end if;
      execute v_new;
    end if;
  end loop;
end
$patch$;
