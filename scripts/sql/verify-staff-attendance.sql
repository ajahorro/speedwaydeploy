-- Scratch-database test of staff attendance, the clock-out guard and the work history. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
set local session_replication_role = replica;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;
select id as sa from public.profiles where role = 'STAFF' and is_active order by created_at limit 1 \gset
select id as sb from public.profiles where role = 'STAFF' and is_active and id <> :'sa' order by created_at limit 1 \gset
select id as cu from public.profiles where role = 'CUSTOMER' order by created_at limit 1 \gset
select id as ad from public.profiles where role = 'ADMIN' order by created_at limit 1 \gset
delete from public.staff_attendance where staff_id in (:'sa', :'sb');
update public.profiles set is_clocked_in = false where id in (:'sa', :'sb');
-- A: a booking starting in 3 minutes, one vehicle for sa
-- B: a booking in 3 hours, one vehicle for sb whose before photo is saved (not started)
-- C: a booking tomorrow, nothing started, for sb2 (sb gets it too, but it is far away)
insert into public.bookings (id, customer_id, customer_name, status, total_amount, start_datetime, end_datetime) values
 ('9c000000-0000-0000-0000-00000000000a', :'cu', 'Soon', 'confirmed', 500, now() + interval '3 minutes', now() + interval '2 hours'),
 ('9c000000-0000-0000-0000-00000000000b', :'cu', 'Photo', 'confirmed', 500, now() + interval '3 hours', now() + interval '4 hours'),
 ('9c000000-0000-0000-0000-00000000000c', :'cu', 'Later', 'confirmed', 500, now() + interval '2 days', now() + interval '2 days 1 hour');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, staff_id) values
 ('9c000000-0000-0000-0000-0000000000a1', '9c000000-0000-0000-0000-00000000000a', 'Sedan', 'Toyota', 'Vios', 'ATT111', 'CONFIRMED', :'sa'),
 ('9c000000-0000-0000-0000-0000000000b1', '9c000000-0000-0000-0000-00000000000b', 'SUV', 'Honda', 'CRV', 'ATT222', 'CONFIRMED', :'sb'),
 ('9c000000-0000-0000-0000-0000000000c1', '9c000000-0000-0000-0000-00000000000c', 'Sedan', 'Mazda', 'M3', 'ATT333', 'CONFIRMED', :'sa');
insert into public.service_photos (booking_id, booking_vehicle_id, phase, storage_path, uploaded_by)
values ('9c000000-0000-0000-0000-00000000000b', '9c000000-0000-0000-0000-0000000000b1', 'before', 'x/att.jpg', :'sb');
set local session_replication_role = origin;

-- attendance is recorded by the trigger
update public.profiles set is_clocked_in = true, clock_in_timestamp = now() - interval '2 hours' where id = :'sa';
insert into t_results select 'clock in opens an attendance row', (select count(*) from public.staff_attendance where staff_id = :'sa' and clock_out_at is null) = 1, '';
update public.profiles set is_clocked_in = true where id = :'sa';
insert into t_results select 'clocking in twice keeps one open row', (select count(*) from public.staff_attendance where staff_id = :'sa' and clock_out_at is null) = 1, '';

-- blockers
insert into t_results select 'a job starting within 5 minutes blocks', exists (select 1 from public.staff_clock_out_blockers(:'sa') where vehicle_id = '9c000000-0000-0000-0000-0000000000a1' and reason = 'STARTS_SOON'), '';
insert into t_results select 'a job two days away does not block', not exists (select 1 from public.staff_clock_out_blockers(:'sa') where vehicle_id = '9c000000-0000-0000-0000-0000000000c1'), '';
insert into t_results select 'a saved before photo blocks even 3 hours ahead', exists (select 1 from public.staff_clock_out_blockers(:'sb') where vehicle_id = '9c000000-0000-0000-0000-0000000000b1' and reason = 'BEFORE_PHOTO_SAVED'), '';

-- the technician's own clock-out is refused
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'sa', 'role', 'authenticated')::text, true);
do $$
begin
  begin
    update public.profiles set is_clocked_in = false where id = (current_setting('request.jwt.claims')::json ->> 'sub')::uuid;
    insert into t_results values ('own direct clock-out is refused', false, 'allowed');
  exception when others then
    insert into t_results values ('own direct clock-out is refused', sqlerrm ilike '%ask an admin%' or sqlerrm ilike '%protected%', sqlerrm);
  end;
end $$;
insert into t_results select 'my_clock_out_blockers lists the blocker', (select count(*) from public.my_clock_out_blockers()) = 1, '';
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null

-- once the blocking job is reassigned the clock-out goes through and the row closes
update public.booking_vehicles set staff_id = :'sb' where id = '9c000000-0000-0000-0000-0000000000a1';
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
insert into t_results select 'no blockers after reassignment', not exists (select 1 from public.staff_clock_out_blockers(:'sa') where reason = 'STARTS_SOON'), '';
update public.profiles set is_clocked_in = false where id = :'sa';
insert into t_results select 'clock out closes the attendance row', (select count(*) from public.staff_attendance where staff_id = :'sa' and clock_out_at is not null) = 1, '';

-- history: paging by day
insert into public.staff_attendance (staff_id, clock_in_at, clock_out_at) values
 (:'sb', now() - interval '1 day', now() - interval '1 day' + interval '8 hours'),
 (:'sb', now() - interval '3 days', now() - interval '3 days' + interval '8 hours'),
 (:'sb', now() - interval '5 days', now() - interval '5 days' + interval '8 hours'),
 (:'sb', now() - interval '7 days', now() - interval '7 days' + interval '8 hours');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'sb', 'role', 'authenticated')::text, true);
create temp table t_h on commit drop as select public.staff_work_history(:'sb', null, 3) as h;
grant all on t_h to authenticated;
insert into t_results select 'first page holds 3 days', (select jsonb_array_length(h -> 'days') from t_h) = 3, (select (jsonb_array_length(h -> 'days'))::text from t_h);
insert into t_results select 'first page says there is more', (select (h ->> 'has_more')::boolean from t_h), '';
insert into t_results select 'the soonest-first rule: newest day leads', (select (h -> 'days' -> 0 ->> 'day')::date >= (h -> 'days' -> 1 ->> 'day')::date from t_h), '';
insert into t_results select 'a vehicle shows under its day with services array', (select bool_or(jsonb_array_length(d -> 'vehicles') > 0) from t_h, jsonb_array_elements(h -> 'days') d), '';
do $$
begin
  begin
    perform public.staff_work_history((select id from public.profiles where role = 'STAFF' and id <> (current_setting('request.jwt.claims')::json ->> 'sub')::uuid limit 1), null, 3);
    insert into t_results values ('staff cannot read another staff history', false, 'allowed');
  exception when others then
    insert into t_results values ('staff cannot read another staff history', true, sqlerrm);
  end;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', :'ad', 'role', 'authenticated')::text, true);
insert into t_results select 'admin can read a staff history', (select jsonb_array_length(public.staff_work_history(:'sb', null, 3) -> 'days')) = 3, '';
insert into t_results select 'second page starts older', (select (public.staff_work_history(:'sb', (select (h -> 'days' -> 2 ->> 'day')::date from t_h), 3) -> 'days' -> 0 ->> 'day')::date < (select (h -> 'days' -> 2 ->> 'day')::date from t_h)), '';
insert into t_results select 'the range history holds every earlier day of the range', (select count(*) from jsonb_array_elements(public.staff_work_history_range(:'sb', (now() at time zone 'Asia/Manila')::date - 8, (now() at time zone 'Asia/Manila')::date) -> 'days') d where (d ->> 'day')::date < (now() at time zone 'Asia/Manila')::date) = 4, '';
insert into t_results select 'the range history leaves out days outside the range', (select count(*) from jsonb_array_elements(public.staff_work_history_range(:'sb', (now() at time zone 'Asia/Manila')::date - 4, (now() at time zone 'Asia/Manila')::date) -> 'days') d where (d ->> 'day')::date < (now() at time zone 'Asia/Manila')::date) = 2, '';
insert into t_results select 'staff_today lists who clocked in today', exists (select 1 from jsonb_array_elements(public.staff_today() -> 'staff') e where (e ->> 'id')::uuid = :'sa'), '';
insert into t_results select 'staff_today carries the clock-out time', exists (select 1 from jsonb_array_elements(public.staff_today() -> 'staff') e where (e ->> 'id')::uuid = :'sa' and (e -> 'sessions' -> 0 ->> 'clock_out_at') is not null), '';
select set_config('request.jwt.claims', json_build_object('sub', :'sb', 'role', 'authenticated')::text, true);
do $$
begin
  begin
    perform public.staff_work_history_range((select id from public.profiles where role = 'STAFF' and id <> (current_setting('request.jwt.claims')::json ->> 'sub')::uuid limit 1), current_date - 5, current_date);
    insert into t_results values ('staff cannot read another staff range history', false, 'allowed');
  exception when others then
    insert into t_results values ('staff cannot read another staff range history', true, sqlerrm);
  end;
  begin
    perform public.staff_work_history_range((current_setting('request.jwt.claims')::json ->> 'sub')::uuid, current_date - 100, current_date);
    insert into t_results values ('a range over 62 days is refused', false, 'allowed');
  exception when others then
    insert into t_results values ('a range over 62 days is refused', true, sqlerrm);
  end;
end $$;
reset role;

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
