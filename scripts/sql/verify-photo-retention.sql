-- Scratch-database test: photo retention. The nightly job only archives; the records past the purge window are listed
-- for the backend (which removes their files first). A record on legal hold, or still inside the window, is never listed. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create temp table t_results (name text, ok boolean, detail text) on commit drop;

-- one booking with one vehicle to hang the photos on
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
values ('9a000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'retention-cust@test.local', 'x', now(), '{"role":"CUSTOMER"}', now(), now());
insert into public.profiles (id, email, first_name, last_name, full_name, role, is_active)
values ('9a000000-0000-0000-0000-000000000001', 'retention-cust@test.local', 'R', 'C', 'R C', 'CUSTOMER', true)
on conflict (id) do update set role = excluded.role;
set local session_replication_role = replica;
insert into public.bookings (id, customer_id, customer_name, status, total_amount, start_datetime, end_datetime)
values ('9a0000aa-0000-0000-0000-000000000001', '9a000000-0000-0000-0000-000000000001', 'R C', 'completed', 500, now() - interval '40 months', now() - interval '40 months' + interval '1 hour');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status)
values ('9a0000bb-0000-0000-0000-000000000001', '9a0000aa-0000-0000-0000-000000000001', 'Sedan', 'A', 'B', 'RET001', 'COMPLETED');
-- name, uploaded months ago, archived?, legal hold?
insert into public.service_photos (id, booking_id, booking_vehicle_id, phase, storage_path, source, uploaded_at, archived_at, retention_exempt) values
 ('9a0000c1-0000-0000-0000-000000000001', '9a0000aa-0000-0000-0000-000000000001', '9a0000bb-0000-0000-0000-000000000001', 'before', 'old-archived.png',   'upload', now() - interval '26 months', now() - interval '10 months', false),
 ('9a0000c1-0000-0000-0000-000000000002', '9a0000aa-0000-0000-0000-000000000001', '9a0000bb-0000-0000-0000-000000000001', 'before', 'older-archived.png', 'upload', now() - interval '30 months', now() - interval '10 months', false),
 ('9a0000c1-0000-0000-0000-000000000003', '9a0000aa-0000-0000-0000-000000000001', '9a0000bb-0000-0000-0000-000000000001', 'before', 'old-on-hold.png',    'upload', now() - interval '30 months', now() - interval '10 months', true),
 ('9a0000c1-0000-0000-0000-000000000004', '9a0000aa-0000-0000-0000-000000000001', '9a0000bb-0000-0000-0000-000000000001', 'after',  'middle-archived.png', 'upload', now() - interval '18 months', now() - interval '6 months',  false),
 ('9a0000c1-0000-0000-0000-000000000005', '9a0000aa-0000-0000-0000-000000000001', '9a0000bb-0000-0000-0000-000000000001', 'after',  'fresh.png',           'upload', now() - interval '2 months',  null,                        false),
 ('9a0000c1-0000-0000-0000-000000000006', '9a0000aa-0000-0000-0000-000000000001', '9a0000bb-0000-0000-0000-000000000001', 'after',  'old-not-archived.png','upload', now() - interval '14 months', null,                        false),
 ('9a0000c1-0000-0000-0000-000000000007', '9a0000aa-0000-0000-0000-000000000001', '9a0000bb-0000-0000-0000-000000000001', 'after',  'hold-not-archived.png','upload', now() - interval '30 months', null,                       true);
set local session_replication_role = origin;

-- 1. what is due now: archived, past 24 months, not on hold
insert into t_results select 'only the archived records past the purge window are listed',
  (select array_agg(storage_path order by storage_path) from public.service_photos_due_for_purge(100) where storage_path in ('old-archived.png','older-archived.png','old-on-hold.png','middle-archived.png','fresh.png','old-not-archived.png','hold-not-archived.png')) = array['old-archived.png','older-archived.png'],
  coalesce((select string_agg(storage_path, ', ' order by storage_path) from public.service_photos_due_for_purge(100)), 'none');
insert into t_results select 'a record on legal hold is never listed', not exists (select 1 from public.service_photos_due_for_purge(100) where storage_path = 'old-on-hold.png'), '';
insert into t_results select 'a record inside the window is not listed, archived or not',
  not exists (select 1 from public.service_photos_due_for_purge(100) where storage_path in ('middle-archived.png', 'fresh.png', 'old-not-archived.png')), '';
insert into t_results select 'the oldest records come first and the limit is respected',
  (select storage_path from public.service_photos_due_for_purge(1)) = (select storage_path from public.service_photos where storage_path in ('old-archived.png','older-archived.png') order by uploaded_at limit 1), '';

-- 2. the nightly job archives and nothing else
select public.run_service_photo_retention() as archived \gset
insert into t_results select 'the nightly job archives a record past 12 months', (select archived_at is not null from public.service_photos where storage_path = 'old-not-archived.png'), 'archived ' || :'archived';
insert into t_results select 'the nightly job leaves a fresh record alone', (select archived_at is null from public.service_photos where storage_path = 'fresh.png'), '';
insert into t_results select 'the nightly job does not archive a record on legal hold', (select archived_at is null from public.service_photos where storage_path = 'hold-not-archived.png'), '';
insert into t_results select 'the nightly job never deletes a record', (select count(*) from public.service_photos where booking_id = '9a0000aa-0000-0000-0000-000000000001') = 7, 'rows ' || (select count(*) from public.service_photos where booking_id = '9a0000aa-0000-0000-0000-000000000001');

-- 3. the purge window is the Business Hub setting
update public.business_config set photo_retention_purge_months = 36 where id = (select id from public.business_config order by id limit 1);
insert into t_results select 'a longer purge window in the Business Hub holds the records back', not exists (select 1 from public.service_photos_due_for_purge(100) where storage_path in ('old-archived.png', 'older-archived.png')), '';
update public.business_config set photo_retention_purge_months = 28 where id = (select id from public.business_config order by id limit 1);
insert into t_results select 'and a shorter one releases more of them', exists (select 1 from public.service_photos_due_for_purge(100) where storage_path = 'older-archived.png') and not exists (select 1 from public.service_photos_due_for_purge(100) where storage_path = 'old-archived.png'), '';

-- 4. nobody but the backend can ask, and the routine that lost files is gone
insert into t_results select 'only the service account can list the records due', not has_function_privilege('authenticated', 'public.service_photos_due_for_purge(integer)', 'execute') and not has_function_privilege('anon', 'public.service_photos_due_for_purge(integer)', 'execute') and has_function_privilege('service_role', 'public.service_photos_due_for_purge(integer)', 'execute'), '';
insert into t_results select 'the old routine that deleted records without their files no longer exists', to_regprocedure('public.purge_stale_service_photos()') is null, '';

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
