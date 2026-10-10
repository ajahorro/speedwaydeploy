-- Scratch-database test: a customer can book and choose Cash (pay at the shop). Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;
select id as cu from public.profiles where role = 'CUSTOMER' order by created_at limit 1 \gset
update public.business_config set closed_weekdays = '{}';

create or replace function pg_temp.cash_booking(p_status text) returns jsonb language plpgsql as $$
declare v_day timestamptz := date_trunc('day', now()) + interval '20 days 3 hours';
begin
  return public.create_booking_atomic_secure(jsonb_build_object(
    'booking', jsonb_build_object('customer_id', auth.uid(), 'customer_name', 'Cash', 'contact_number', '09171234567', 'start_datetime', v_day, 'end_datetime', v_day + interval '1 hour', 'status', 'scheduled', 'total_amount', 170, 'vehicle_type', 'Sedan', 'is_walk_in', false),
    'vehicles', jsonb_build_array(jsonb_build_object('vehicle', jsonb_build_object('vehicle_type', 'Sedan', 'brand', 'T', 'model', 'C', 'plate_number', 'CASH' || floor(random() * 90000 + 10000)::int, 'status', 'SCHEDULED'), 'services', jsonb_build_array(jsonb_build_object('service_name', 'Basic Carwash', 'price', 170, 'final_price', 170)))),
    'payment', jsonb_build_object('amount', 170, 'method', 'Cash', 'payment_type', 'Full', 'status', p_status, 'notes', 'PAYMENT_CASH')));
end $$;
grant execute on function pg_temp.cash_booking(text) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'cu', 'role', 'authenticated')::text, true);
insert into t_results select 'a customer cash booking is created', (pg_temp.cash_booking('PENDING') #>> '{booking,id}') is not null, '';
insert into t_results select 'the booking is unpaid and the cash payment waits for the shop', exists (select 1 from public.bookings b join public.payments p on p.booking_id = b.id where b.customer_id = :'cu' and b.payment_status::text = 'unpaid' and upper(p.method) = 'CASH' and upper(p.status::text) = 'PENDING' and b.customer_name = 'Cash'), '';
reset role;
select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
