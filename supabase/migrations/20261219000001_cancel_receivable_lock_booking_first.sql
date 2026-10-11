-- Cancelling an "amount to be received" read and updated the payment without locking its booking first, while
-- admin_cancel_booking locks the booking and then its payments. Overlapping on the same booking could deadlock (Postgres
-- ends one of the two with an error; money stays correct, but that request fails). Same fix as admin_verify_payment:
-- take the booking lock first, then lock the payment.

do $patch$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.admin_cancel_receivable(uuid)'::regprocedure) into v_def;
  if v_def not like '%for update%' then
    v_new := replace(
      v_def,
      E'  select * into v_row from public.payments where id = p_payment_id;',
      E'  -- lock order: booking first, then payment (the same order admin_cancel_booking uses)\n  perform 1 from public.bookings where id = (select booking_id from public.payments where id = p_payment_id) for update;\n  select * into v_row from public.payments where id = p_payment_id for update;'
    );
    if v_new = v_def then raise exception 'admin_cancel_receivable layout changed; patch not applied'; end if;
    execute v_new;
  end if;
end
$patch$;
