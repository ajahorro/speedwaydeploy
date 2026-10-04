-- RLS matrix for public.booking_vehicles and public.booking_vehicle_services.
-- Every block runs in a rolled-back transaction.
-- Fixtures (01_seed + 05_vehicles_seed), vehicle ids e...<suffix>:
--   a1 -> booking a1 (Customer A / Staff S), a2 -> booking a2 (Customer A / unassigned),
--   a3 -> booking a3 (Customer A / Staff S, completed),
--   b1, b2 -> booking b1 (Customer B / Staff T). One service line per vehicle.
\pset tuples_only on
\pset format unaligned
\set VA1 '''e0000000-0000-4000-8000-0000000000a1'''
\set VA3 '''e0000000-0000-4000-8000-0000000000a3'''
\set VB1 '''e0000000-0000-4000-8000-0000000000b1'''
\set VIDS 'select coalesce(string_agg(right(id::text,2), '','' order by id), ''none'') from public.booking_vehicles'
\set SIDS 'select coalesce(string_agg(right(booking_vehicle_id::text,2), '','' order by booking_vehicle_id), ''none'') from public.booking_vehicle_services'
\set ANON  'set local role anon; select set_config(''request.jwt.claims'', ''{"role":"anon"}'', true) \\g /dev/null'
\set CUSTA 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-000000000001"}'', true) \\g /dev/null'
\set CUSTB 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-000000000002"}'', true) \\g /dev/null'
\set STAFFS 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"bbbbbbbb-0000-4000-8000-000000000001"}'', true) \\g /dev/null'
\set STAFFT 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"bbbbbbbb-0000-4000-8000-000000000002"}'', true) \\g /dev/null'
\set ADMIN 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"cccccccc-0000-4000-8000-000000000001"}'', true) \\g /dev/null'
\set SVC   'set local role service_role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', true) \\g /dev/null'
\set NOTES 'select public.update_booking_vehicle_service_notes('

\echo '== anon =='
begin; :ANON
select rlst.chk('anon SELECT booking_vehicles', rlst.val(:'VIDS'), 'err:42501');
select rlst.chk('anon SELECT booking_vehicle_services', rlst.val(:'SIDS'), 'err:42501');
select rlst.chk('anon UPDATE booking_vehicles', rlst.try_sql($$update public.booking_vehicles set plate_number = 'X'$$), 'err:42501');
select rlst.chk('anon UPDATE booking_vehicle_services', rlst.try_sql('update public.booking_vehicle_services set price = 1'), 'err:42501');
select rlst.chk('anon DELETE booking_vehicles', rlst.try_sql('delete from public.booking_vehicles'), 'err:42501');
select rlst.chk('anon DELETE booking_vehicle_services', rlst.try_sql('delete from public.booking_vehicle_services'), 'err:42501');
select rlst.chk('anon INSERT booking_vehicles', rlst.try_sql('insert into public.booking_vehicles (booking_id, plate_number) values (' || '''d0000000-0000-4000-8000-0000000000a1''' || ', ''X'')'), 'err:42501');
select rlst.chk('anon INSERT booking_vehicle_services', rlst.try_sql('insert into public.booking_vehicle_services (booking_vehicle_id, service_name, price) values (' || :'VA1' || ', ''X'', 1)'), 'err:42501');
select rlst.chk('anon notes RPC', rlst.val(:'NOTES' || :'VA1' || ', ''x'')'), 'err:42501');
rollback;

\echo '== customer A =='
begin; :CUSTA
select rlst.chk('custA sees only own vehicles', rlst.val(:'VIDS'), 'a1,a2,a3');
select rlst.chk('custA sees only own service lines', rlst.val(:'SIDS'), 'a1,a2,a3');
select rlst.chk('custA garage history by plate of custB (BBB222) -> none', rlst.val($$select count(*) from public.booking_vehicles where plate_number = 'BBB222'$$), '0');
select rlst.chk('custA garage history own plate AAA111', rlst.val($$select count(*) from public.booking_vehicles where plate_number = 'AAA111'$$), '3');
select rlst.chk('custA UPDATE own vehicle directly', rlst.try_sql($$update public.booking_vehicles set plate_number = 'X' where id = $$ || :'VA1'), 'ok:0');
select rlst.chk('custA UPDATE own service price directly', rlst.try_sql('update public.booking_vehicle_services set price = 1'), 'ok:0');
select rlst.chk('custA UPDATE other vehicle', rlst.try_sql($$update public.booking_vehicles set plate_number = 'X' where id = $$ || :'VB1'), 'ok:0');
select rlst.chk('custA DELETE vehicles', rlst.try_sql('delete from public.booking_vehicles'), 'ok:0');
select rlst.chk('custA DELETE services', rlst.try_sql('delete from public.booking_vehicle_services'), 'ok:0');
select rlst.chk('custA INSERT vehicle on own booking', rlst.try_sql('insert into public.booking_vehicles (booking_id, plate_number) values (''d0000000-0000-4000-8000-0000000000a1'', ''X'')'), 'err:42501');
select rlst.chk('custA INSERT service on own vehicle', rlst.try_sql('insert into public.booking_vehicle_services (booking_vehicle_id, service_name, price) values (' || :'VA1' || ', ''Free'', 0)'), 'err:42501');
select rlst.chk('custA notes RPC on own vehicle (not staff)', rlst.val(:'NOTES' || :'VA1' || ', ''x'')'), 'err:P0002');
select rlst.chk('custA occupancy RPC still sees all vehicles', rlst.val($$select sum(jsonb_array_length(vehicles)) from public.get_schedule_occupancy('2026-11-10 00:00+08', '2026-11-11 00:00+08')$$), '4');
rollback;

\echo '== customer B =='
begin; :CUSTB
select rlst.chk('custB sees only own vehicles', rlst.val(:'VIDS'), 'b1,b2');
select rlst.chk('custB sees only own service lines', rlst.val(:'SIDS'), 'b1,b2');
rollback;

\echo '== staff S (assigned a1, a3) =='
begin; :STAFFS
select rlst.chk('staffS sees vehicles of assigned bookings', rlst.val(:'VIDS'), 'a1,a3');
select rlst.chk('staffS sees service lines of assigned bookings', rlst.val(:'SIDS'), 'a1,a3');
select rlst.chk('staffS work history (COMPLETED units on assigned bookings)', rlst.val($$select count(*) from public.booking_vehicles v join public.bookings b on b.id = v.booking_id where b.staff_id = auth.uid() and v.status in ('COMPLETED','CANCELLED')$$), '1');
select rlst.chk('staffS service_photos insert policy join still resolves', rlst.val('select count(*) from public.bookings b join public.booking_vehicles v on v.booking_id = b.id where b.staff_id = auth.uid() and v.id = ' || :'VA1'), '1');
select rlst.chk('staffS direct UPDATE notes (old client path)', rlst.try_sql($$update public.booking_vehicles set service_notes = 'x' where id = $$ || :'VA1'), 'ok:0');
select rlst.chk('staffS direct UPDATE status', rlst.try_sql($$update public.booking_vehicles set status = 'COMPLETED' where id = $$ || :'VA1'), 'ok:0');
select rlst.chk('staffS DELETE', rlst.try_sql('delete from public.booking_vehicles'), 'ok:0');
select rlst.chk('staffS notes RPC on assigned vehicle', rlst.val(:'NOTES' || :'VA1' || ', ''  scratch on left door  '')'), 'scratch on left door');
select rlst.chk('staffS notes persisted (visible via RLS)', rlst.val('select service_notes from public.booking_vehicles where id = ' || :'VA1'), 'scratch on left door');
select rlst.chk('staffS notes RPC clears with empty string', rlst.val(:'NOTES' || :'VA1' || ', '''')'), '<null>');
select rlst.chk('staffS notes RPC on unassigned vehicle', rlst.val(:'NOTES' || :'VB1' || ', ''x'')'), 'err:P0002');
select rlst.chk('staffS notes RPC on missing vehicle', rlst.val(:'NOTES' || '''e0000000-0000-4000-8000-0000000000ff'', ''x'')'), 'err:P0002');
select rlst.chk('staffS notes RPC on finalized booking', rlst.val(:'NOTES' || :'VA3' || ', ''x'')'), 'err:22023');
select rlst.chk('staffS notes RPC too long', rlst.val(:'NOTES' || :'VA1' || ', repeat(''x'', 4001))'), 'err:22001');
rollback;

\echo '== staff S notes RPC changes only service_notes =='
begin; :STAFFS
select rlst.val(:'NOTES' || :'VA1' || ', ''n'')') \g /dev/null
:SVC
select rlst.chk('other columns untouched', rlst.val('select concat_ws(''|'', plate_number, status, brand, service_notes) from public.booking_vehicles where id = ' || :'VA1'), 'AAA111|SCHEDULED|Toyota|n');
rollback;

\echo '== staff T (assigned b1) =='
begin; :STAFFT
select rlst.chk('staffT sees only assigned vehicles', rlst.val(:'VIDS'), 'b1,b2');
select rlst.chk('staffT notes RPC on staffS vehicle', rlst.val(:'NOTES' || :'VA1' || ', ''x'')'), 'err:P0002');
rollback;

\echo '== deactivated staff S =='
begin;
-- Fixture step only: the staff-protection trigger refuses to deactivate staff
-- with an active service, so skip triggers for this one update.
set local session_replication_role = replica;
update public.profiles set is_active = false where id = 'bbbbbbbb-0000-4000-8000-000000000001';
set local session_replication_role = origin;
:STAFFS
select rlst.chk('inactive staff notes RPC', rlst.val(:'NOTES' || :'VA1' || ', ''x'')'), 'err:P0002');
rollback;

\echo '== admin =='
begin; :ADMIN
select rlst.chk('admin sees all vehicles', rlst.val(:'VIDS'), 'a1,a2,a3,b1,b2');
select rlst.chk('admin sees all service lines', rlst.val(:'SIDS'), 'a1,a2,a3,b1,b2');
select rlst.chk('admin dashboard vehicle status scan', rlst.val('select count(status) from public.booking_vehicles'), '5');
select rlst.chk('admin UPDATE vehicle', rlst.try_sql($$update public.booking_vehicles set service_notes = 'admin' where id = $$ || :'VB1'), 'ok:1');
select rlst.chk('admin INSERT service line', rlst.try_sql('insert into public.booking_vehicle_services (booking_vehicle_id, service_name, price) values (' || :'VB1' || ', ''Wax'', 300)'), 'ok:1');
select rlst.chk('admin DELETE service line', rlst.try_sql('delete from public.booking_vehicle_services where booking_vehicle_id = ' || :'VB1'), 'ok:1');
select rlst.chk('admin assign staff (workload trigger reads vehicles)', rlst.try_sql($$update public.bookings set staff_id = 'bbbbbbbb-0000-4000-8000-000000000002' where id = 'd0000000-0000-4000-8000-0000000000a2'$$), 'ok:1');
select rlst.chk('admin notes RPC any open vehicle', rlst.val(:'NOTES' || :'VB1' || ', ''admin note'')'), 'admin note');
rollback;

\echo '== deactivated admin =='
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.profiles set is_active = false where id = 'cccccccc-0000-4000-8000-000000000001';
:ADMIN
select rlst.chk('inactive admin sees no vehicles', rlst.val(:'VIDS'), 'none');
select rlst.chk('inactive admin notes RPC', rlst.val(:'NOTES' || :'VB1' || ', ''x'')'), 'err:P0002');
rollback;

\echo '== service role (backend) =='
begin; :SVC
select rlst.chk('backend sees all vehicles', rlst.val(:'VIDS'), 'a1,a2,a3,b1,b2');
select rlst.chk('backend update vehicle', rlst.try_sql($$update public.booking_vehicles set service_notes = 'svc' where id = $$ || :'VA1'), 'ok:1');
rollback;
