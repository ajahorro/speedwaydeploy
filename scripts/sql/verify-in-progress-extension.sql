-- Scratch-database test: adding a service to a booking that is already under way. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create temp table t_results (name text, ok boolean, detail text) on commit drop;
set local session_replication_role = replica;
select id as cu from public.profiles where role = 'CUSTOMER' order by created_at limit 1 \gset
select id as ad from public.profiles where role = 'ADMIN' order by created_at limit 1 \gset
insert into public.bookings (id, customer_id, customer_name, status, total_amount, start_datetime, end_datetime)
values ('9e000000-0000-0000-0000-000000000001', :'cu', 'Running', 'in_progress', 170, now() - interval '30 minutes', now() + interval '15 minutes');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, started_at) values
 ('9e000000-0000-0000-0000-0000000000a1', '9e000000-0000-0000-0000-000000000001', 'Sedan', 'Toyota', 'Vios', 'IP111', 'IN_PROGRESS', now() - interval '30 minutes');
insert into public.booking_vehicle_services (booking_vehicle_id, service_name, price, duration_minutes, vehicle_type)
values ('9e000000-0000-0000-0000-0000000000a1', 'Basic Carwash', 170, 45, 'Sedan');
set local session_replication_role = origin;

-- the extra time is free: the running job can be extended (even outside the shop's hours)
select public.apply_added_services('9e000000-0000-0000-0000-000000000001',
  jsonb_build_array(jsonb_build_object('vehicle_id','9e000000-0000-0000-0000-0000000000a1','service_name','Bac To Zero','price',400,'duration',60,'vehicle_type','Sedan')),
  null, null, :'ad', 'Admin', 'ADMIN', 'test') \g /dev/null
insert into t_results select 'a running job can get a service', (select total_amount from public.bookings where id = '9e000000-0000-0000-0000-000000000001') = 570, '';

-- other bookings fill every bay in the next hour: a further service is refused with a clear message
set local session_replication_role = replica;
insert into public.bookings (customer_id, customer_name, status, total_amount, start_datetime, end_datetime)
select :'cu', 'Next ' || g, 'confirmed', 100, (select end_datetime from public.bookings where id = '9e000000-0000-0000-0000-000000000001') + interval '5 minutes',
       (select end_datetime from public.bookings where id = '9e000000-0000-0000-0000-000000000001') + interval '50 minutes'
  from generate_series(1, greatest(1, coalesce((public.shop_capacity() ->> 'effective')::integer, 1))) g;
set local session_replication_role = origin;
do $$
declare v_msg text := '';
begin
  begin
    perform public.apply_added_services('9e000000-0000-0000-0000-000000000001',
      jsonb_build_array(jsonb_build_object('vehicle_id','9e000000-0000-0000-0000-0000000000a1','service_name','Hand/Spray Wax','price',650,'duration',60,'vehicle_type','Sedan')),
      null, null, (select id from public.profiles where role='ADMIN' limit 1), 'Admin', 'ADMIN', 'test');
  exception when others then v_msg := sqlerrm;
  end;
  insert into t_results values ('refused when another booking needs the bay', v_msg ilike '%needs the bay%', v_msg);
end $$;
insert into t_results select 'the refused service left the total alone', (select total_amount from public.bookings where id = '9e000000-0000-0000-0000-000000000001') = 570, '';

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
