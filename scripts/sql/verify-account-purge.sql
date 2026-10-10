-- Scratch-database test: roles are fixed; deactivated accounts are kept for the grace period, then deleted. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create temp table t_results (name text, ok boolean, detail text) on commit drop;

create or replace function pg_temp.mk(p_id uuid, p_email text, p_role text) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, 'x', now(), jsonb_build_object('role', p_role, 'first_name', 'T', 'last_name', 'T'), now(), now())
  on conflict (id) do nothing;
  insert into public.profiles (id, email, first_name, last_name, full_name, role, is_active)
  values (p_id, p_email, 'T', 'T', 'T T', p_role, true)
  on conflict (id) do update set role = excluded.role, is_active = true;
end $$;

select pg_temp.mk('9f000000-0000-0000-0000-000000000001', 'purge-cust-old@test.local', 'CUSTOMER');
select pg_temp.mk('9f000000-0000-0000-0000-000000000002', 'purge-cust-new@test.local', 'CUSTOMER');
select pg_temp.mk('9f000000-0000-0000-0000-000000000003', 'purge-staff-old@test.local', 'STAFF');
select pg_temp.mk('9f000000-0000-0000-0000-000000000004', 'purge-admin-old@test.local', 'ADMIN');
select pg_temp.mk('9f000000-0000-0000-0000-000000000005', 'purge-staff-live@test.local', 'STAFF');

-- the old customer has a booking with a payment, a vehicle and a notification; the old technician worked on a booking
set local session_replication_role = replica;
insert into public.bookings (id, customer_id, customer_name, status, total_amount, start_datetime, end_datetime)
values ('9f0000aa-0000-0000-0000-000000000001', '9f000000-0000-0000-0000-000000000001', 'Gone', 'completed', 500, now() - interval '40 days', now() - interval '40 days' + interval '1 hour'),
       ('9f0000aa-0000-0000-0000-000000000002', '9f000000-0000-0000-0000-000000000002', 'Stays', 'completed', 500, now() - interval '30 days', now() - interval '30 days' + interval '1 hour');
insert into public.payments (booking_id, amount, method, payment_type, status) values ('9f0000aa-0000-0000-0000-000000000001', 500, 'GCash', 'Full', 'PAID');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, staff_id)
values ('9f0000bb-0000-0000-0000-000000000001', '9f0000aa-0000-0000-0000-000000000002', 'Sedan', 'A', 'B', 'PRG111', 'COMPLETED', '9f000000-0000-0000-0000-000000000003');
set local session_replication_role = origin;
insert into public.vehicles (owner_id, type, brand, model, plate_number) values ('9f000000-0000-0000-0000-000000000001', 'Sedan', 'Gone', 'Car', 'PRG999');

-- the roles cannot be changed, in any direction
create or replace function pg_temp.try(p_name text, p_sql text, p_expect_error text) returns void language plpgsql as $$
begin
  execute p_sql;
  insert into t_results values (p_name, false, 'allowed');
exception when others then
  insert into t_results values (p_name, sqlerrm ilike '%' || p_expect_error || '%', sqlerrm);
end $$;
select pg_temp.try('customer cannot become staff', $$update public.profiles set role = 'STAFF' where id = '9f000000-0000-0000-0000-000000000002'$$, 'keeps the role');
select pg_temp.try('customer cannot become admin', $$update public.profiles set role = 'ADMIN' where id = '9f000000-0000-0000-0000-000000000002'$$, 'keeps the role');
select pg_temp.try('staff cannot become admin', $$update public.profiles set role = 'ADMIN' where id = '9f000000-0000-0000-0000-000000000005'$$, 'keeps the role');
select pg_temp.try('admin cannot become staff', $$update public.profiles set role = 'STAFF' where id = '9f000000-0000-0000-0000-000000000004'$$, 'keeps the role');
select pg_temp.try('staff cannot become a customer', $$update public.profiles set role = 'CUSTOMER' where id = '9f000000-0000-0000-0000-000000000005'$$, 'keeps the role');

-- deactivating staff keeps the role and bans sign-in
select public.deactivate_staff_account('9f000000-0000-0000-0000-000000000003', 'test');
insert into t_results select 'a deactivated technician keeps the staff role', (select role = 'STAFF' and is_active = false from public.profiles where id = '9f000000-0000-0000-0000-000000000003'), '';
insert into t_results select 'a deactivated technician cannot sign in', (select banned_until > now() from auth.users where id = '9f000000-0000-0000-0000-000000000003'), '';
select public.reactivate_staff_account('9f000000-0000-0000-0000-000000000003');
insert into t_results select 'reactivating restores sign-in and a fresh joined date', (select is_active and hired_at = current_date from public.profiles where id = '9f000000-0000-0000-0000-000000000003') and (select banned_until is null from auth.users where id = '9f000000-0000-0000-0000-000000000003'), '';

-- deactivated at different times
select public.deactivate_staff_account('9f000000-0000-0000-0000-000000000003', 'test');
select public.deactivate_staff_account('9f000000-0000-0000-0000-000000000004', 'test');
update public.profiles set is_active = false, deactivated_at = now() - interval '20 days' where id = '9f000000-0000-0000-0000-000000000001';
update public.profiles set is_active = false, deactivated_at = now() - interval '3 days' where id = '9f000000-0000-0000-0000-000000000002';
update public.profiles set deactivated_at = now() - interval '16 days' where id in ('9f000000-0000-0000-0000-000000000003', '9f000000-0000-0000-0000-000000000004');

select public.purge_deactivated_accounts() as purged \gset
insert into t_results select 'only accounts past the grace period are deleted', :purged = 3, 'purged ' || :'purged';
insert into t_results select 'the old customer is gone from the database entirely', not exists (select 1 from public.profiles where id = '9f000000-0000-0000-0000-000000000001') and not exists (select 1 from auth.users where id = '9f000000-0000-0000-0000-000000000001'), '';
insert into t_results select 'the old customer''s vehicles and bookings are gone with it', not exists (select 1 from public.vehicles where plate_number = 'PRG999') and not exists (select 1 from public.bookings where id = '9f0000aa-0000-0000-0000-000000000001'), '';
insert into t_results select 'the old technician is gone and their bookings stay', not exists (select 1 from public.profiles where id = '9f000000-0000-0000-0000-000000000003') and exists (select 1 from public.bookings where id = '9f0000aa-0000-0000-0000-000000000002') and (select staff_id is null from public.booking_vehicles where id = '9f0000bb-0000-0000-0000-000000000001'), '';
insert into t_results select 'the old administrator is gone', not exists (select 1 from public.profiles where id = '9f000000-0000-0000-0000-000000000004'), '';
insert into t_results select 'a customer deactivated 3 days ago is still there', exists (select 1 from public.profiles where id = '9f000000-0000-0000-0000-000000000002'), '';
insert into t_results select 'an active technician is untouched', exists (select 1 from public.profiles where id = '9f000000-0000-0000-0000-000000000005' and is_active), '';
insert into t_results select 'the deletion is recorded without personal details', exists (select 1 from public.audit_logs where action_type = 'ACCOUNT_PURGED' and details not like '%@%'), '';
insert into t_results select 'no purge failed', not exists (select 1 from public.audit_logs where action_type = 'ACCOUNT_PURGE_FAILED'), coalesce((select details from public.audit_logs where action_type = 'ACCOUNT_PURGE_FAILED' limit 1), '');

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
