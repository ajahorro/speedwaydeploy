-- Scratch-database test: before photos open at the scheduled time; an early start can be allowed. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
set local session_replication_role = replica;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;
select id as sa from public.profiles where role = 'STAFF' and is_active order by created_at limit 1 \gset
select id as sb from public.profiles where role = 'STAFF' and is_active and id <> :'sa' order by created_at limit 1 \gset
select id as cu from public.profiles where role = 'CUSTOMER' order by created_at limit 1 \gset
select id as ad from public.profiles where role = 'ADMIN' order by created_at limit 1 \gset
-- A: later today (30 min away), sa     B: time already reached, sa     C: two days away, sa
-- D: later today, sa, will be moved    E: later today, sa; admin allows it
insert into public.bookings (id, customer_id, customer_name, status, total_amount, start_datetime, end_datetime) values
 ('9d000000-0000-0000-0000-00000000000a', :'cu', 'A', 'confirmed', 500, least(now() + interval '30 minutes', (date_trunc('day', now() at time zone 'Asia/Manila') + interval '23 hours 58 minutes') at time zone 'Asia/Manila'), now() + interval '2 hours'),
 ('9d000000-0000-0000-0000-00000000000b', :'cu', 'B', 'confirmed', 500, now() - interval '10 minutes', now() + interval '1 hour'),
 ('9d000000-0000-0000-0000-00000000000c', :'cu', 'C', 'confirmed', 500, now() + interval '2 days', now() + interval '2 days 1 hour'),
 ('9d000000-0000-0000-0000-00000000000d', :'cu', 'D', 'confirmed', 500, least(now() + interval '30 minutes', (date_trunc('day', now() at time zone 'Asia/Manila') + interval '23 hours 58 minutes') at time zone 'Asia/Manila'), now() + interval '2 hours'),
 ('9d000000-0000-0000-0000-00000000000e', :'cu', 'E', 'confirmed', 500, least(now() + interval '30 minutes', (date_trunc('day', now() at time zone 'Asia/Manila') + interval '23 hours 58 minutes') at time zone 'Asia/Manila'), now() + interval '2 hours');
insert into public.payments (booking_id, amount, method, payment_type, status)
select id, 500, 'GCash', 'Full', 'PAID' from public.bookings where id::text like '9d000000%';
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, staff_id)
select ('9d000000-0000-0000-0000-0000000000' || right(b.id::text, 2))::uuid, b.id, 'Sedan', 'Toyota', 'Vios', 'EAR' || right(b.id::text, 2), 'CONFIRMED', :'sa'
  from public.bookings b where b.id::text like '9d000000%';
set local session_replication_role = origin;

create or replace function pg_temp.try(p_name text, p_sql text, p_expect_error text default null) returns void language plpgsql as $$
declare v_out text;
begin
  execute p_sql into v_out;
  insert into t_results values (p_name, p_expect_error is null and coalesce(v_out, 'true') <> 'false', coalesce(v_out, ''));
exception when others then
  insert into t_results values (p_name, p_expect_error is not null and sqlerrm ilike '%' || p_expect_error || '%', sqlerrm);
end $$;
grant execute on function pg_temp.try(text, text, text) to authenticated;

create or replace function pg_temp.photo(p_booking text, p_vehicle text) returns text language plpgsql as $$
begin
  insert into public.service_photos (booking_id, booking_vehicle_id, phase, storage_path, uploaded_by)
  values (p_booking::uuid, p_vehicle::uuid, 'before', 'x/' || p_vehicle || '.jpg', auth.uid());
  return 'saved';
end $$;
grant execute on function pg_temp.photo(text, text) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'sa', 'role', 'authenticated')::text, true);
select pg_temp.try('before the scheduled time the technician cannot add a before photo', $$select pg_temp.photo('9d000000-0000-0000-0000-00000000000a', '9d000000-0000-0000-0000-0000000000' || '0a')$$, 'row-level security');
select pg_temp.try('once the time is reached the before photo is accepted', $$select pg_temp.photo('9d000000-0000-0000-0000-00000000000b', '9d000000-0000-0000-0000-0000000000' || '0b')$$);
select pg_temp.try('an early start for a booking two days away is refused', $$select public.allow_early_start('9d000000-0000-0000-0000-00000000000c')::text$$, 'scheduled day');
select pg_temp.try('(technician tries to write the allowance directly)', $$update public.bookings set early_start_allowed_at = now() where id = '9d000000-0000-0000-0000-00000000000e' returning 'updated'$$, 'booking screen');
select pg_temp.try('the assigned technician can allow an early start', $$select public.allow_early_start('9d000000-0000-0000-0000-00000000000a')::text$$);
select pg_temp.try('after that the early before photo is accepted', $$select pg_temp.photo('9d000000-0000-0000-0000-00000000000a', '9d000000-0000-0000-0000-0000000000' || '0a')$$);
select pg_temp.try('the allowance is recorded in the booking history', $$select (exists (select 1 from public.audit_logs where booking_id = '9d000000-0000-0000-0000-00000000000a' and action_type = 'EARLY_START_ALLOWED'))::text$$);

select set_config('request.jwt.claims', json_build_object('sub', :'sb', 'role', 'authenticated')::text, true);
select pg_temp.try('another technician cannot allow it', $$select public.allow_early_start('9d000000-0000-0000-0000-00000000000e')::text$$, 'assigned technician');

select set_config('request.jwt.claims', json_build_object('sub', :'cu', 'role', 'authenticated')::text, true);
select pg_temp.try('a customer cannot allow it', $$select public.allow_early_start('9d000000-0000-0000-0000-00000000000e')::text$$, 'assigned technician');
select pg_temp.try('(customer tries to write the allowance directly)', $$update public.bookings set early_start_allowed_at = now() where id = '9d000000-0000-0000-0000-00000000000e' returning 'updated'$$, 'booking screen');

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
insert into t_results select 'neither technician nor customer could write the allowance directly', (select early_start_allowed_at is null from public.bookings where id = '9d000000-0000-0000-0000-00000000000e'), '';
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ad', 'role', 'authenticated')::text, true);
select pg_temp.try('an admin can allow an early start', $$select public.allow_early_start('9d000000-0000-0000-0000-00000000000e')::text$$);
select pg_temp.try('allowing twice is harmless', $$select public.allow_early_start('9d000000-0000-0000-0000-00000000000e')::text$$);
select pg_temp.try('the start-time rule sees the allowance', $$select public.booking_start_time_reached('9d000000-0000-0000-0000-00000000000e')::text$$);
select pg_temp.try('the start-time rule is closed without it', $$select (not public.booking_start_time_reached('9d000000-0000-0000-0000-00000000000d'))::text$$);
reset role;

-- moving a booking to a later time ends the allowance
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
set local session_replication_role = origin;
update public.bookings set start_datetime = date_trunc('day', now()) + interval '6 days 3 hours', end_datetime = date_trunc('day', now()) + interval '6 days 4 hours' where id = '9d000000-0000-0000-0000-00000000000e';
insert into t_results select 'rescheduling later clears the allowance', (select early_start_allowed_at is null from public.bookings where id = '9d000000-0000-0000-0000-00000000000e'), '';

delete from t_results where name like '(%';
select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
