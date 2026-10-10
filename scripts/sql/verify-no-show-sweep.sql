-- Scratch-database test: the no-show sweep is not stopped by a booking whose technician uploaded a before photo,
-- and one booking that cannot be processed does not stop the others. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create temp table t_results (name text, ok boolean, detail text) on commit drop;

create or replace function pg_temp.mk(p_id uuid, p_email text, p_role text) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, 'x', now(), jsonb_build_object('role', p_role), now(), now()) on conflict (id) do nothing;
  insert into public.profiles (id, email, first_name, last_name, full_name, role, is_active)
  values (p_id, p_email, 'T', 'T', 'T T', p_role, true) on conflict (id) do update set role = excluded.role, is_active = true;
end $$;
select pg_temp.mk('9d100000-0000-0000-0000-000000000001', 'ns-cust@test.local', 'CUSTOMER');
select pg_temp.mk('9d100000-0000-0000-0000-000000000002', 'ns-tech@test.local', 'STAFF');
select pg_temp.mk('9d100000-0000-0000-0000-000000000003', 'ns-tech2@test.local', 'STAFF');

set local session_replication_role = replica;
-- 1 has a before photo by its technician (never started)   2 has no photo   3 is on time (not due)   4 will be made to fail
insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime, staff_id) values
 ('9d1000aa-0000-0000-0000-000000000001', '9d100000-0000-0000-0000-000000000001', 'N S', 'confirmed', 'paid', 500, now() - interval '3 hours', now() - interval '2 hours', '9d100000-0000-0000-0000-000000000002'),
 ('9d1000aa-0000-0000-0000-000000000002', '9d100000-0000-0000-0000-000000000001', 'N S', 'confirmed', 'paid', 500, now() - interval '3 hours', now() - interval '2 hours', '9d100000-0000-0000-0000-000000000002'),
 ('9d1000aa-0000-0000-0000-000000000003', '9d100000-0000-0000-0000-000000000001', 'N S', 'confirmed', 'paid', 500, now() - interval '10 minutes', now() + interval '50 minutes', '9d100000-0000-0000-0000-000000000002'),
 ('9d1000aa-0000-0000-0000-000000000004', '9d100000-0000-0000-0000-000000000001', 'N S', 'scheduled', 'paid', 500, now() - interval '3 hours', now() - interval '2 hours', '9d100000-0000-0000-0000-000000000002');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, staff_id)
select ('9d1000bb-0000-0000-0000-00000000000' || n)::uuid, ('9d1000aa-0000-0000-0000-00000000000' || n)::uuid, 'Sedan', 'A', 'B', 'NS00' || n, 'SCHEDULED', '9d100000-0000-0000-0000-000000000002'::uuid from generate_series(1, 4) n;
insert into public.service_photos (booking_id, booking_vehicle_id, phase, storage_path, source, uploaded_by)
values ('9d1000aa-0000-0000-0000-000000000001', '9d1000bb-0000-0000-0000-000000000001', 'before', 'x/before.png', 'upload', '9d100000-0000-0000-0000-000000000002');
insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime, staff_id) values ('9d1000aa-0000-0000-0000-000000000005', '9d100000-0000-0000-0000-000000000001', 'N S', 'confirmed', 'paid', 500, now() - interval '20 minutes', now() + interval '40 minutes', '9d100000-0000-0000-0000-000000000003');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, staff_id) values ('9d1000bb-0000-0000-0000-000000000005', '9d1000aa-0000-0000-0000-000000000005', 'Sedan', 'A', 'B', 'NS005', 'SCHEDULED', '9d100000-0000-0000-0000-000000000003');
insert into public.service_photos (booking_id, booking_vehicle_id, phase, storage_path, source, uploaded_by) values ('9d1000aa-0000-0000-0000-000000000005', '9d1000bb-0000-0000-0000-000000000005', 'before', 'x/before5.png', 'upload', '9d100000-0000-0000-0000-000000000003');
insert into public.payments (booking_id, amount, method, payment_type, status) values ('9d1000aa-0000-0000-0000-000000000001', 500, 'GCash', 'Full', 'PAID');
set local session_replication_role = origin;

-- the lock still protects a booking that is running normally
create or replace function pg_temp.try(p_name text, p_sql text, p_expect text) returns void language plpgsql as $$
begin
  execute p_sql;
  insert into t_results values (p_name, false, 'allowed');
exception when others then
  insert into t_results values (p_name, sqlerrm ilike '%' || p_expect || '%', sqlerrm);
end $$;
select pg_temp.try('a technician stays locked in after their before photo (normal reassignment)', $$update public.bookings set staff_id = '9d100000-0000-0000-0000-000000000003' where id = '9d1000aa-0000-0000-0000-000000000001'$$, 'LOCKED_AFTER_BEFORE_PHOTO');

-- booking 4 is made to fail, as an unexpected problem with one booking would
create function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'simulated problem with this booking'; end $$;
create trigger zz_boom before update on public.bookings for each row when (old.id = '9d1000aa-0000-0000-0000-000000000004') execute function pg_temp.boom();

select (public.run_no_show_lifecycle()->>'flagged')::int as flagged \gset
insert into t_results select 'the sweep runs to the end (a booking with the technician''s before photo no longer stops it)', true, 'flagged ' || :'flagged';
insert into t_results select 'the booking with a before photo is flagged as a no-show', (select status from public.bookings where id = '9d1000aa-0000-0000-0000-000000000001') in ('FLAGGED_NOSHOW', 'cancelled'), (select status from public.bookings where id = '9d1000aa-0000-0000-0000-000000000001');
insert into t_results select 'the booking without a photo is flagged in the same run', (select status from public.bookings where id = '9d1000aa-0000-0000-0000-000000000002') in ('FLAGGED_NOSHOW', 'cancelled'), (select status from public.bookings where id = '9d1000aa-0000-0000-0000-000000000002');
insert into t_results select 'the technician is remembered for an undo', (select no_show_staff_id from public.bookings where id = '9d1000aa-0000-0000-0000-000000000001') = '9d100000-0000-0000-0000-000000000002', '';
insert into t_results select 'a booking that is on time is left alone', (select status from public.bookings where id = '9d1000aa-0000-0000-0000-000000000003') = 'confirmed', '';
insert into t_results select 'a booking that cannot be processed is skipped, not flagged', (select status from public.bookings where id = '9d1000aa-0000-0000-0000-000000000004') = 'scheduled', '';
insert into t_results select 'and the reason is written to the audit log', exists (select 1 from public.audit_logs where action_type = 'NO_SHOW_SWEEP_FAILED' and booking_id = '9d1000aa-0000-0000-0000-000000000004' and details like '%simulated problem%'), '';
insert into t_results select 'the payment on a flagged booking is queued for refund', (select status from public.payments where booking_id = '9d1000aa-0000-0000-0000-000000000001') = 'REFUND_PENDING', '';

select public.run_no_show_lifecycle();
insert into t_results select 'running the sweep again does not repeat the failure entry', (select count(*) from public.audit_logs where action_type = 'NO_SHOW_SWEEP_FAILED' and booking_id = '9d1000aa-0000-0000-0000-000000000004') = 1, '';
insert into t_results select 'only the service account can record a sweep failure', not has_function_privilege('authenticated', 'public.record_no_show_sweep_failure(uuid,text,text)', 'execute'), '';

-- reminders: booking 5 has its before photo, its time has come, and it is not started
insert into t_results select 'the technician is told to start a booking whose intake is done', (select count(*) from public.notifications where booking_id = '9d1000aa-0000-0000-0000-000000000005' and user_id = '9d100000-0000-0000-0000-000000000003' and notification_type = 'START_SERVICE_PROMPT') = 1, '';
insert into t_results select 'the administrators are told too', exists (select 1 from public.notifications where booking_id = '9d1000aa-0000-0000-0000-000000000005' and notification_type = 'UNSTARTED_SERVICE'), '';
insert into t_results select 'a booking with no before photo gets no reminder', not exists (select 1 from public.notifications where booking_id = '9d1000aa-0000-0000-0000-000000000003' and notification_type in ('START_SERVICE_PROMPT', 'UNSTARTED_SERVICE')), '';
insert into t_results select 'a booking that was flagged gets no reminder', not exists (select 1 from public.notifications where booking_id = '9d1000aa-0000-0000-0000-000000000001' and notification_type in ('START_SERVICE_PROMPT', 'UNSTARTED_SERVICE')), '';
insert into t_results select 'running the sweep again does not remind twice', (select count(*) from public.notifications where booking_id = '9d1000aa-0000-0000-0000-000000000005' and notification_type = 'START_SERVICE_PROMPT') = 1, '';

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
