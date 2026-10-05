-- Scratch-database test of per-vehicle technicians. Rolled back.
--   docker exec -i <db-container> psql -U postgres < scripts/sql/verify-per-vehicle-technicians.sql
-- Needs two STAFF profiles (the scratch seed has Test Staff ...f1 and a second technician).
begin;
set local session_replication_role = replica;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;

select id as sa from public.profiles where role = 'STAFF' and is_active order by created_at limit 1 \gset
select id as sb from public.profiles where role = 'STAFF' and is_active and id <> :'sa' order by created_at limit 1 \gset
select id as cu from public.profiles where role = 'CUSTOMER' order by created_at limit 1 \gset

-- the workload limit is exercised at the end; before that, leftovers on a shared scratch database must not interfere
update public.business_config set max_vehicles_per_staff = 50;

-- a fresh scheduled booking with two vehicles and no technician
insert into public.bookings (id, customer_id, status, total_amount, start_datetime, end_datetime)
values ('99000000-0000-0000-0000-000000000001', :'cu', 'scheduled', 3000, now() + interval '3 day', now() + interval '3 day 2 hour');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, created_at) values
 ('99000000-0000-0000-0000-0000000000a1', '99000000-0000-0000-0000-000000000001', 'Sedan', 'Toyota', 'Vios', 'AAA111', 'PENDING', now() - interval '1 minute'),
 ('99000000-0000-0000-0000-0000000000a2', '99000000-0000-0000-0000-000000000001', 'SUV', 'Honda', 'CRV', 'BBB222', 'PENDING', now());
set local session_replication_role = origin;

create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default '') returns void language sql as
$$ insert into t_results values (p_name, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.try(p_name text, p_sql text, p_expect_error text default null)
returns void language plpgsql as $$
declare v_out text;
begin
  begin
    execute p_sql into v_out;
    insert into t_results values (p_name, p_expect_error is null, coalesce(v_out, ''));
  exception when others then
    insert into t_results values (p_name, p_expect_error is not null and sqlerrm ilike '%' || p_expect_error || '%', sqlerrm);
  end;
end $$;

-- 1. assigning the booking assigns every vehicle
update public.bookings set staff_id = :'sa' where id = '99000000-0000-0000-0000-000000000001';
select pg_temp.check('booking technician reaches every vehicle',
  (select count(*) = 2 and bool_and(staff_id = :'sa') from public.booking_vehicles where booking_id = '99000000-0000-0000-0000-000000000001'));

-- 2. one vehicle gets a different technician; the lead stays with the first vehicle
update public.booking_vehicles set staff_id = :'sb' where id = '99000000-0000-0000-0000-0000000000a2';
select pg_temp.check('a vehicle can have its own technician',
  (select staff_id = :'sb' from public.booking_vehicles where id = '99000000-0000-0000-0000-0000000000a2')
  and (select staff_id = :'sa' from public.booking_vehicles where id = '99000000-0000-0000-0000-0000000000a1'));
select pg_temp.check('the booking lead follows the first vehicle',
  (select staff_id = :'sa' from public.bookings where id = '99000000-0000-0000-0000-000000000001'));

-- 3. changing the first vehicle moves the lead, not the other vehicle
update public.booking_vehicles set staff_id = :'sb' where id = '99000000-0000-0000-0000-0000000000a1';
select pg_temp.check('changing the first vehicle moves the lead',
  (select staff_id = :'sb' from public.bookings where id = '99000000-0000-0000-0000-000000000001'));
update public.booking_vehicles set staff_id = :'sa' where id = '99000000-0000-0000-0000-0000000000a1';

-- 4. history: each change is written once, as a vehicle change
select pg_temp.check('vehicle changes are audited',
  (select count(*) >= 2 from public.audit_logs where booking_id = '99000000-0000-0000-0000-000000000001' and action_type = 'STAFF_ASSIGNMENT_CHANGED' and details ilike '%Vios%' or details ilike '%CRV%'));

-- 5. what each technician can see
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'sa', 'role', 'authenticated')::text, true);
select pg_temp.check('technician A sees only their vehicle',
  (select count(*) = 1 and bool_and(id = '99000000-0000-0000-0000-0000000000a1') from public.booking_vehicles where booking_id = '99000000-0000-0000-0000-000000000001'));
select pg_temp.check('technician A sees the booking', (select count(*) = 1 from public.bookings where id = '99000000-0000-0000-0000-000000000001'));
select set_config('request.jwt.claims', json_build_object('sub', :'sb', 'role', 'authenticated')::text, true);
select pg_temp.check('technician B sees only their vehicle',
  (select count(*) = 1 and bool_and(id = '99000000-0000-0000-0000-0000000000a2') from public.booking_vehicles where booking_id = '99000000-0000-0000-0000-000000000001'));
select pg_temp.check('technician B sees the booking (through their vehicle)', (select count(*) = 1 from public.bookings where id = '99000000-0000-0000-0000-000000000001'));
select pg_temp.try('technician B cannot write notes on A''s vehicle', $$select public.update_booking_vehicle_service_notes('99000000-0000-0000-0000-0000000000a1', 'x')$$, 'Vehicle not found');
select pg_temp.try('technician B can write notes on their own vehicle', $$select public.update_booking_vehicle_service_notes('99000000-0000-0000-0000-0000000000a2', 'ok')$$);
reset role;

-- 6. customer sees each technician per vehicle
select set_config('request.jwt.claims', json_build_object('sub', :'cu', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check('customer sees a technician per vehicle', (select count(*) = 2 and count(distinct technician_name) = 2 from public.get_customer_booking_technicians('99000000-0000-0000-0000-000000000001')));
reset role;

-- 7. clearing the booking clears every vehicle
update public.bookings set staff_id = null where id = '99000000-0000-0000-0000-000000000001';
select pg_temp.check('clearing the booking technician clears every vehicle',
  (select bool_and(staff_id is null) from public.booking_vehicles where booking_id = '99000000-0000-0000-0000-000000000001'));

-- 8. a new vehicle inherits the booking technician
update public.bookings set staff_id = :'sa' where id = '99000000-0000-0000-0000-000000000001';
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status)
values ('99000000-0000-0000-0000-0000000000a3', '99000000-0000-0000-0000-000000000001', 'Sedan', 'Mazda', 'M3', 'CCC333', 'PENDING');
select pg_temp.check('a vehicle added later inherits the technician', (select staff_id = :'sa' from public.booking_vehicles where id = '99000000-0000-0000-0000-0000000000a3'));

-- 9. technician in use cannot be treated as free
select pg_temp.check('a technician with assigned vehicles counts as having active services', public.staff_has_active_services(:'sa'));

-- 10. workload limit uses the configured number
select count(*) as already from public.booking_vehicles bv join public.bookings b on b.id = bv.booking_id
 where bv.staff_id = :'sa' and lower(b.status) in ('pending', 'confirmed', 'in_progress', 'ongoing', 'scheduled') \gset
update public.business_config set max_vehicles_per_staff = greatest(:already + 1, 1);
set local session_replication_role = replica;
insert into public.bookings (id, customer_id, status, total_amount, start_datetime, end_datetime)
values ('99000000-0000-0000-0000-000000000002', :'cu', 'scheduled', 1000, now() + interval '4 day', now() + interval '4 day 1 hour');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status) values
 ('99000000-0000-0000-0000-0000000000b1', '99000000-0000-0000-0000-000000000002', 'Sedan', 'A', 'A', 'W1', 'PENDING'),
 ('99000000-0000-0000-0000-0000000000b2', '99000000-0000-0000-0000-000000000002', 'Sedan', 'B', 'B', 'W2', 'PENDING');
set local session_replication_role = origin;
select pg_temp.try('workload limit counts vehicles against the configured limit',
  format($f$update public.booking_vehicles set staff_id = %L where id in ('99000000-0000-0000-0000-0000000000b1','99000000-0000-0000-0000-0000000000b2')$f$, :'sa'),
  'Workload limit exceeded');

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
