-- RLS matrix for public.bookings. Every block runs in a rolled-back transaction.
-- Fixtures: a1 = Customer A / Staff S, a2 = Customer A / unassigned, b1 = Customer B / Staff T.
\pset tuples_only on
\pset format unaligned
\set A1 '''d0000000-0000-4000-8000-0000000000a1'''
\set A2 '''d0000000-0000-4000-8000-0000000000a2'''
\set B1 '''d0000000-0000-4000-8000-0000000000b1'''
\set IDS 'select coalesce(string_agg(right(id::text,2), '','' order by id), ''none'') from public.bookings'
\set ANON  'set local role anon; select set_config(''request.jwt.claims'', ''{"role":"anon"}'', true) \\g /dev/null'
\set CUSTA 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-000000000001"}'', true) \\g /dev/null'
\set CUSTB 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-000000000002"}'', true) \\g /dev/null'
\set STAFFS 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"bbbbbbbb-0000-4000-8000-000000000001"}'', true) \\g /dev/null'
\set STAFFT 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"bbbbbbbb-0000-4000-8000-000000000002"}'', true) \\g /dev/null'
\set ADMIN 'set local role authenticated; select set_config(''request.jwt.claims'', ''{"role":"authenticated","sub":"cccccccc-0000-4000-8000-000000000001"}'', true) \\g /dev/null'
\set SVC   'set local role service_role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', true) \\g /dev/null'

\echo '== anon (landing page / logged-out visitor) =='
begin; :ANON
select rlst.chk('anon SELECT bookings',  rlst.val(:'IDS'), 'err:42501');
select rlst.chk('anon UPDATE bookings',  rlst.try_sql('update public.bookings set total_amount = 1'), 'err:42501');
select rlst.chk('anon DELETE bookings',  rlst.try_sql('delete from public.bookings'), 'err:42501');
select rlst.chk('anon INSERT bookings',  rlst.try_sql($$insert into public.bookings (customer_name, start_datetime, end_datetime) values ('x', now(), now() + interval '1 hour')$$), 'err:42501');
select rlst.chk('anon get_schedule_occupancy', rlst.val($$select count(*) from public.get_schedule_occupancy('2026-11-10 00:00+08', '2026-11-11 00:00+08')$$), 'err:42501');
select rlst.chk('anon capture_booking_qr_snapshot', rlst.val('select public.capture_booking_qr_snapshot(' || :'A1' || ')'), 'err:42501');
select rlst.chk('anon create_booking_atomic_secure', rlst.val($$select public.create_booking_atomic_secure('{}'::jsonb)$$), 'err:42501');
rollback;

\echo '== customer A =='
begin; :CUSTA
select rlst.chk('custA sees only own bookings', rlst.val(:'IDS'), 'a1,a2');
select rlst.chk('custA booking list (fetchCustomerBookings shape)',
  rlst.val($$select count(*) || ' bookings/' || sum(nv) || ' vehicles' from (select b.id, (select count(*) from public.booking_vehicles v where v.booking_id = b.id) nv from public.bookings b where b.customer_id = auth.uid()) s$$), '2 bookings/2 vehicles');
select rlst.chk('custA fetchBookingById(other customer) -> no row', rlst.val('select count(*) from public.bookings where id = ' || :'B1'), '0');
select rlst.chk('custA UPDATE own booking directly (no client writes)', rlst.try_sql('update public.bookings set total_amount = 1 where id = ' || :'A1'), 'ok:0');
select rlst.chk('custA UPDATE other booking', rlst.try_sql('update public.bookings set total_amount = 1 where id = ' || :'B1'), 'ok:0');
select rlst.chk('custA cancel own booking directly', rlst.try_sql($$update public.bookings set status = 'cancelled' where id = $$ || :'A1'), 'ok:0');
select rlst.chk('custA DELETE', rlst.try_sql('delete from public.bookings'), 'ok:0');
select rlst.chk('custA direct INSERT', rlst.try_sql($$insert into public.bookings (customer_id, customer_name, start_datetime, end_datetime) values (auth.uid(), 'x', '2026-11-12 10:00+08', '2026-11-12 11:00+08')$$), 'err:42501');
select rlst.chk('custA occupancy sees ALL bookings in window', rlst.val($$select count(*) || '/' || sum(jsonb_array_length(vehicles)) from public.get_schedule_occupancy('2026-11-10 00:00+08', '2026-11-11 00:00+08')$$), '3/4');
select rlst.chk('custA occupancy exposes no identities', rlst.val($$select string_agg(distinct k, ',' order by k) from public.get_schedule_occupancy('2026-11-10 00:00+08', '2026-11-11 00:00+08') o, jsonb_object_keys(to_jsonb(o)) k$$), 'end_datetime,start_datetime,status,vehicles');
select rlst.chk('custA occupancy vehicle keys', rlst.val($$select string_agg(distinct k, ',' order by k) from public.get_schedule_occupancy('2026-11-10 00:00+08', '2026-11-11 00:00+08') o, jsonb_array_elements(o.vehicles) v, jsonb_object_keys(v) k$$), 'status,vehicle_type');
select rlst.chk('custA occupancy excludes rescheduled booking', rlst.val('select count(*) from public.get_schedule_occupancy(''2026-11-10 00:00+08'', ''2026-11-11 00:00+08'', ' || :'A1' || ')'), '2');
select rlst.chk('custA occupancy strict overlap (11:00-12:00 hits a1,b1)', rlst.val($$select count(*) from public.get_schedule_occupancy('2026-11-10 11:00+08', '2026-11-10 12:00+08')$$), '2');
select rlst.chk('custA occupancy window > 14 days rejected', rlst.val($$select count(*) from public.get_schedule_occupancy('2026-11-01', '2026-12-01')$$), 'err:22023');
select rlst.chk('custA capture QR snapshot on own booking', rlst.val('select public.capture_booking_qr_snapshot(' || :'A1' || ')->>''qr_config_version'''), '3');
select rlst.chk('custA capture QR snapshot on other booking', rlst.val('select public.capture_booking_qr_snapshot(' || :'B1' || ')'), 'err:P0002');
select rlst.chk('custA financial ledger own', rlst.val('select (public.booking_financial_ledger(' || :'A1' || ') is not null)::text'), 'true');
select rlst.chk('custA financial ledger other', rlst.val('select (public.booking_financial_ledger(' || :'B1' || ') is not null)::text'), 'err:P0002');
rollback;

\echo '== customer A: create_booking_atomic_secure (wizard submit) =='
begin; :CUSTA
select rlst.chk('custA create_booking_atomic_secure',
  rlst.val($$select (public.create_booking_atomic_secure('{
     "booking": {"customer_id":"aaaaaaaa-0000-4000-8000-000000000001","customer_name":"Customer A","customer_email":"cust.a@rls.test",
                 "start_datetime":"2026-11-10T16:00:00+08:00","end_datetime":"2026-11-10T17:00:00+08:00",
                 "total_amount":500,"estimated_duration_total":60,"payment_method":"CASH","payment_type":"full"},
     "vehicles": [{"vehicle":{"vehicle_type":"Sedan","brand":"Toyota","model":"Vios","plate_number":"AAA111","subtotal":500},
                   "services":[{"service_name":"Wash","price":500,"final_price":500,"base_price":500,"price_at_booking":500,"duration_minutes":60,"vehicle_type":"Sedan"}]}],
     "payment": {"method":"CASH","amount":500,"verdict":"UNPAID","payment_type":"full"}
   }'::jsonb) #>> '{booking,id}') is not null$$), 'true');
select rlst.chk('custA sees new booking after create', rlst.val('select count(*) from public.bookings'), '3');
select rlst.chk('new booking got a server QR snapshot', rlst.val($$select active_qr_snapshot->>'qr_account_name' from public.bookings where start_datetime = '2026-11-10 16:00+08'$$), 'Speedway Test');
rollback;

\echo '== customer B =='
begin; :CUSTB
select rlst.chk('custB sees only own bookings', rlst.val(:'IDS'), 'b1');
rollback;

\echo '== staff S (assigned a1) =='
begin; :STAFFS
select rlst.chk('staffS sees only assigned bookings', rlst.val(:'IDS'), 'a1');
select rlst.chk('staffS work history join (booking_vehicles !inner bookings)', rlst.val('select count(*) from public.booking_vehicles v join public.bookings b on b.id = v.booking_id where b.staff_id = auth.uid()'), '1');
select rlst.chk('staffS UPDATE assigned booking directly', rlst.try_sql($$update public.bookings set status = 'in_progress' where id = $$ || :'A1'), 'ok:0');
select rlst.chk('staffS DELETE', rlst.try_sql('delete from public.bookings'), 'ok:0');
select rlst.chk('staffS financial ledger assigned', rlst.val('select (public.booking_financial_ledger(' || :'A1' || ') is not null)::text'), 'true');
select rlst.chk('staffS financial ledger unassigned', rlst.val('select (public.booking_financial_ledger(' || :'B1' || ') is not null)::text'), 'err:P0002');
select rlst.chk('staffS capture QR snapshot (not owner)', rlst.val('select public.capture_booking_qr_snapshot(' || :'A1' || ')'), 'err:P0002');
select rlst.chk('staffS occupancy still works', rlst.val($$select count(*) from public.get_schedule_occupancy('2026-11-10 00:00+08', '2026-11-11 00:00+08')$$), '3');
rollback;

\echo '== staff T (assigned b1) =='
begin; :STAFFT
select rlst.chk('staffT sees only assigned bookings', rlst.val(:'IDS'), 'b1');
rollback;

\echo '== admin =='
begin; :ADMIN
select rlst.chk('admin sees all bookings', rlst.val(:'IDS'), 'a1,a2,b1');
select rlst.chk('admin bookings page join (customer profile)', rlst.val('select count(p.full_name) from public.bookings b left join public.profiles p on p.id = b.customer_id'), '3');
select rlst.chk('admin dashboard unassigned count', rlst.val($$select count(*) from public.bookings where staff_id is null and status not ilike 'cancelled'$$), '1');
select rlst.chk('admin assign staff (AdminBookingDetails)', rlst.try_sql($$update public.bookings set staff_id = 'bbbbbbbb-0000-4000-8000-000000000001', assigned_by = auth.uid(), assigned_at = now() where id = $$ || :'A2'), 'ok:1');
select rlst.chk('admin reject payment (payment_status update)', rlst.try_sql($$update public.bookings set payment_status = 'unpaid' where id = $$ || :'B1'), 'ok:1');
select rlst.chk('admin queue refund (AdminPayments)', rlst.try_sql($$update public.bookings set refund_status = 'QUEUED' where id = $$ || :'B1'), 'ok:1');
select rlst.chk('admin capture QR snapshot any booking', rlst.val('select public.capture_booking_qr_snapshot(' || :'B1' || ')->>''qr_config_version'''), '3');
select rlst.chk('admin financial ledger any booking', rlst.val('select (public.booking_financial_ledger(' || :'B1' || ') is not null)::text'), 'true');
select rlst.chk('admin direct INSERT', rlst.try_sql($$insert into public.bookings (customer_id, customer_name, start_datetime, end_datetime) values (null, 'Walk-in', '2026-11-12 10:00+08', '2026-11-12 11:00+08')$$), 'ok:1');
select rlst.chk('admin DELETE', rlst.try_sql('delete from public.bookings where id = ' || :'A2'), 'ok:1');
rollback;

\echo '== deactivated admin =='
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.profiles set is_active = false where id = 'cccccccc-0000-4000-8000-000000000001';
:ADMIN
select rlst.chk('inactive admin sees nothing', rlst.val(:'IDS'), 'none');
rollback;

\echo '== service role (backend: cancellation, staff task queue) =='
begin; :SVC
select rlst.chk('backend staff task query (staff_id = S)', rlst.val($$select count(*) from public.bookings where staff_id = 'bbbbbbbb-0000-4000-8000-000000000001'$$), '1');
select rlst.chk('backend cancel booking', rlst.try_sql($$update public.bookings set status = 'cancelled' where id = $$ || :'A2'), 'ok:1');
rollback;
