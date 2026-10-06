-- Scratch-database test of apply_added_services: several services in one step, one payment, one notice,
-- all-or-nothing. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
set local session_replication_role = replica;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
select id as cu from public.profiles where role = 'CUSTOMER' order by created_at limit 1 \gset
select id as ad from public.profiles where role = 'ADMIN' order by created_at limit 1 \gset
select count(*) as admin_count from public.profiles where upper(role) = 'ADMIN' and coalesce(is_active, true) \gset
insert into public.bookings (id, customer_id, customer_name, status, total_amount, start_datetime, end_datetime)
values ('97000000-0000-0000-0000-000000000001', :'cu', 'Several Services', 'confirmed', 170, date_trunc('day', now() + interval '97 days') + interval '2 hours', date_trunc('day', now() + interval '97 days') + interval '2 hours 45 minutes');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status) values
 ('97000000-0000-0000-0000-0000000000a1', '97000000-0000-0000-0000-000000000001', 'Sedan', 'Toyota', 'Vios', 'SEV111', 'QUEUED');
insert into public.booking_vehicle_services (booking_vehicle_id, service_name, price, duration_minutes, vehicle_type)
values ('97000000-0000-0000-0000-0000000000a1', 'Basic Carwash', 170, 45, 'Sedan');
delete from public.notifications where booking_id = '97000000-0000-0000-0000-000000000001';
set local session_replication_role = origin;

-- three services at once, with one payment
select public.apply_added_services(
  '97000000-0000-0000-0000-000000000001',
  jsonb_build_array(
    jsonb_build_object('vehicle_id', '97000000-0000-0000-0000-0000000000a1', 'service_name', 'Bac To Zero', 'price', 400, 'duration', 60, 'vehicle_type', 'Sedan'),
    jsonb_build_object('vehicle_id', '97000000-0000-0000-0000-0000000000a1', 'service_name', 'Hand/Spray Wax', 'price', 650, 'duration', 60, 'vehicle_type', 'Sedan'),
    jsonb_build_object('vehicle_id', '97000000-0000-0000-0000-0000000000a1', 'service_name', 'Ceiling Cleaning', 'price', 500, 'duration', 60, 'vehicle_type', 'Sedan')),
  jsonb_build_object('amount', 800, 'method', 'GCash', 'payment_type', 'Downpayment', 'status', 'FOR_VERIFICATION', 'reference_number', 'SEVREF0001', 'notes', 'test'),
  null, :'cu', 'Customer', 'CUSTOMER', 'test') as pid \gset

insert into t_results select 'the three services are added', (select count(*) from public.booking_vehicle_services where booking_vehicle_id = '97000000-0000-0000-0000-0000000000a1') = 4, '';
insert into t_results select 'the total is the sum of all of them', (select total_amount from public.bookings where id = '97000000-0000-0000-0000-000000000001') = 170 + 400 + 650 + 500, '';
insert into t_results select 'the booking is longer by the combined time', (select end_datetime - start_datetime from public.bookings where id = '97000000-0000-0000-0000-000000000001') = interval '45 minutes' + interval '180 minutes', '';
insert into t_results select 'one payment is recorded', (select count(*) from public.payments where booking_id = '97000000-0000-0000-0000-000000000001') = 1, '';
insert into t_results select 'the administrators get one notice, naming every service',
  (select count(*) from public.notifications where booking_id = '97000000-0000-0000-0000-000000000001' and notification_type = 'SERVICE_ADDED') = :admin_count
  and (select bool_and(message like '%"Bac To Zero", "Hand/Spray Wax", "Ceiling Cleaning"%') from public.notifications where booking_id = '97000000-0000-0000-0000-000000000001' and notification_type = 'SERVICE_ADDED'), '';

-- all or nothing: the second service is already on the vehicle, so the whole request is refused
do $$
declare v_before numeric; v_after numeric; v_failed boolean := false;
begin
  select total_amount into v_before from public.bookings where id = '97000000-0000-0000-0000-000000000001';
  begin
    perform public.apply_added_services(
      '97000000-0000-0000-0000-000000000001',
      jsonb_build_array(
        jsonb_build_object('vehicle_id', '97000000-0000-0000-0000-0000000000a1', 'service_name', 'Carpet Cleaning', 'price', 500, 'duration', 60, 'vehicle_type', 'Sedan'),
        jsonb_build_object('vehicle_id', '97000000-0000-0000-0000-0000000000a1', 'service_name', 'Bac To Zero', 'price', 400, 'duration', 60, 'vehicle_type', 'Sedan')),
      null, null, null, 'Customer', 'CUSTOMER', 'test');
  exception when others then v_failed := true;
  end;
  select total_amount into v_after from public.bookings where id = '97000000-0000-0000-0000-000000000001';
  insert into t_results values ('a duplicate in the list refuses the whole request', v_failed, '');
  insert into t_results values ('and nothing was added', v_before = v_after and not exists (select 1 from public.booking_vehicle_services where booking_vehicle_id = '97000000-0000-0000-0000-0000000000a1' and service_name = 'Carpet Cleaning'), '');
end $$;

do $$
begin
  begin
    perform public.apply_added_services('97000000-0000-0000-0000-000000000001', '[]'::jsonb, null, null, null, 'x', 'ADMIN', 'x');
    insert into t_results values ('an empty list is refused (error)', false, 'accepted');
  exception when others then
    insert into t_results values ('an empty list is refused (error)', true, sqlerrm);
  end;
end $$;

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
