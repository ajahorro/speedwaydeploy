-- Scratch-database test: proof of refund. A refund cannot be recorded without its proof; a reference or picture
-- cannot be used twice (including one already used on a payment); only the booking's customer and administrators
-- can read a proof; only the service account can write one. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to public;

create or replace function pg_temp.mk(p_id uuid, p_email text, p_role text) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, 'x', now(), jsonb_build_object('role', p_role), now(), now()) on conflict (id) do nothing;
  insert into public.profiles (id, email, first_name, last_name, full_name, role, is_active)
  values (p_id, p_email, 'T', 'T', 'T T', p_role, true) on conflict (id) do update set role = excluded.role, is_active = true;
end $$;
select pg_temp.mk('9e100000-0000-0000-0000-000000000001', 'rp-cust@test.local', 'CUSTOMER');
select pg_temp.mk('9e100000-0000-0000-0000-000000000002', 'rp-cust2@test.local', 'CUSTOMER');
select pg_temp.mk('9e100000-0000-0000-0000-000000000003', 'rp-admin@test.local', 'ADMIN');
select pg_temp.mk('9e100000-0000-0000-0000-000000000004', 'rp-staff@test.local', 'STAFF');

set local session_replication_role = replica;
insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime) values
 ('9e1000aa-0000-0000-0000-000000000001', '9e100000-0000-0000-0000-000000000001', 'R P', 'cancelled', 'paid', 1000, now() + interval '2 days', now() + interval '2 days 1 hour'),
 ('9e1000aa-0000-0000-0000-000000000002', '9e100000-0000-0000-0000-000000000001', 'R P', 'cancelled', 'paid', 1000, now() + interval '3 days', now() + interval '3 days 1 hour');
insert into public.payments (booking_id, amount, method, payment_type, status, reference_number) values
 ('9e1000aa-0000-0000-0000-000000000001', 1000, 'GCash', 'Full', 'PAID', 'PAYREF000111'),
 ('9e1000aa-0000-0000-0000-000000000002', 1000, 'GCash', 'Full', 'PAID', 'PAYREF000222');
set local session_replication_role = origin;

create or replace function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;
create or replace function pg_temp.try(p_name text, p_sql text, p_expect text) returns void language plpgsql as $$
begin
  execute p_sql;
  insert into t_results values (p_name, false, 'allowed');
exception when others then
  insert into t_results values (p_name, sqlerrm ilike '%' || p_expect || '%', sqlerrm);
end $$;
create or replace function pg_temp.proofs_visible() returns int language sql as $$ select count(*)::int from public.refund_proofs $$;

-- the refund is refused without a proof
select pg_temp.as_user('9e100000-0000-0000-0000-000000000003');
select pg_temp.try('a refund without its proof is refused', $$select public.process_booking_refund_v2('9e1000aa-0000-0000-0000-000000000001', 1000, 'Customer Request', 'RFD-TEST-0001', 0, 'BANK TRANSFER', '9e100000-0000-0000-0000-000000000003')$$, 'REFUND_PROOF_REQUIRED');

-- the proof is recorded by the service account only
select pg_temp.try('an administrator cannot write a proof from the browser', $$insert into public.refund_proofs (booking_id, refund_reference, storage_path, proof_reference, image_hash) values ('9e1000aa-0000-0000-0000-000000000001', 'RFD-TEST-0001', 'x/y.jpg', 'REFPROOF001', 'hash-a')$$, 'permission denied');
select pg_temp.as_service();
insert into public.refund_proofs (booking_id, refund_reference, storage_path, proof_reference, image_hash, refund_method)
values ('9e1000aa-0000-0000-0000-000000000001', 'RFD-TEST-0001', '9e1000aa-0000-0000-0000-000000000001/RFD-TEST-0001.jpg', 'REFPROOF001', 'hash-a', 'BANK TRANSFER');

-- repeats are refused
select pg_temp.try('the same reference cannot back another refund', $$insert into public.refund_proofs (booking_id, refund_reference, storage_path, proof_reference, image_hash) values ('9e1000aa-0000-0000-0000-000000000002', 'RFD-TEST-0002', 'x/z.jpg', 'refproof001', 'hash-b')$$, 'duplicate key');
select pg_temp.try('the same picture cannot back another refund', $$insert into public.refund_proofs (booking_id, refund_reference, storage_path, proof_reference, image_hash) values ('9e1000aa-0000-0000-0000-000000000002', 'RFD-TEST-0002', 'x/z.jpg', 'REFPROOF002', 'hash-a')$$, 'duplicate key');
select pg_temp.try('a reference already used on a payment is refused', $$insert into public.refund_proofs (booking_id, refund_reference, storage_path, proof_reference, image_hash) values ('9e1000aa-0000-0000-0000-000000000002', 'RFD-TEST-0002', 'x/z.jpg', 'payref000111', 'hash-c')$$, 'REFERENCE_REUSED');
select pg_temp.try('one refund has one proof', $$insert into public.refund_proofs (booking_id, refund_reference, storage_path, proof_reference, image_hash) values ('9e1000aa-0000-0000-0000-000000000001', 'RFD-TEST-0001', 'x/z.jpg', 'REFPROOF003', 'hash-d')$$, 'duplicate key');
insert into public.refund_proofs (booking_id, refund_reference, storage_path, proof_reference, image_hash, refund_method)
values ('9e1000aa-0000-0000-0000-000000000002', 'RFD-TEST-CASH1', '9e1000aa-0000-0000-0000-000000000002/RFD-TEST-CASH1.jpg', null, 'hash-cash', 'CASH');
insert into public.refund_proofs (booking_id, refund_reference, storage_path, proof_reference, image_hash, refund_method)
values ('9e1000aa-0000-0000-0000-000000000002', 'RFD-TEST-CASH2', 'x/c2.jpg', null, 'hash-cash2', 'CASH');
insert into t_results select 'cash proofs need no reference (two can exist without one)', (select count(*) from public.refund_proofs where proof_reference is null) = 2, '';

-- with the proof the refund goes through, recorded under the same reference
select pg_temp.as_user('9e100000-0000-0000-0000-000000000003');
select public.process_booking_refund_v2('9e1000aa-0000-0000-0000-000000000001', 1000, 'Customer Request', 'RFD-TEST-0001', 0, 'BANK TRANSFER', '9e100000-0000-0000-0000-000000000003');
insert into t_results select 'with its proof the refund is recorded', exists (select 1 from public.payments where booking_id = '9e1000aa-0000-0000-0000-000000000001' and method = 'SYSTEM_REFUND' and reference_number = 'RFD-TEST-0001'), '';
select pg_temp.try('a proof for another reference does not unlock a refund', $$select public.process_booking_refund_v2('9e1000aa-0000-0000-0000-000000000002', 500, 'Customer Request', 'RFD-TEST-OTHER', 0, 'CASH', '9e100000-0000-0000-0000-000000000003')$$, 'REFUND_PROOF_REQUIRED');
select public.process_booking_refund_v2('9e1000aa-0000-0000-0000-000000000002', 500, 'Customer Request', 'RFD-TEST-CASH1', 0, 'CASH', '9e100000-0000-0000-0000-000000000003');
insert into t_results select 'a cash refund goes through with its picture alone', exists (select 1 from public.payments where booking_id = '9e1000aa-0000-0000-0000-000000000002' and method = 'SYSTEM_REFUND' and reference_number = 'RFD-TEST-CASH1'), '';

-- who can read
insert into t_results select 'an administrator sees every proof', pg_temp.proofs_visible() = 3, pg_temp.proofs_visible()::text;
select pg_temp.as_user('9e100000-0000-0000-0000-000000000001');
insert into t_results select 'the customer of the bookings sees their proofs', pg_temp.proofs_visible() = 3, pg_temp.proofs_visible()::text;
select pg_temp.as_user('9e100000-0000-0000-0000-000000000002');
insert into t_results select 'another customer sees none', pg_temp.proofs_visible() = 0, pg_temp.proofs_visible()::text;
select pg_temp.as_user('9e100000-0000-0000-0000-000000000004');
insert into t_results select 'staff do not see refund proofs', pg_temp.proofs_visible() = 0, pg_temp.proofs_visible()::text;
select pg_temp.try('a customer cannot delete a proof', $$delete from public.refund_proofs where booking_id = '9e1000aa-0000-0000-0000-000000000001'$$, 'permission denied');
select pg_temp.as_service();
insert into t_results select 'a customer cannot delete or change a proof (no policy)', not exists (select 1 from information_schema.role_table_grants where table_name = 'refund_proofs' and grantee = 'authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')), '';

-- orphans: a proof whose refund never happened is found after a day
insert into public.refund_proofs (booking_id, refund_reference, storage_path, proof_reference, image_hash, created_at)
values ('9e1000aa-0000-0000-0000-000000000001', 'RFD-TEST-ORPHAN', 'x/orphan.jpg', 'REFPROOF009', 'hash-orphan', now() - interval '2 days');
insert into t_results select 'an unused proof older than a day is listed for clean-up', exists (select 1 from public.refund_proofs_without_refund('1 day') where storage_path = 'x/orphan.jpg'), '';
insert into t_results select 'a proof that backs a refund is never listed', not exists (select 1 from public.refund_proofs_without_refund('0 seconds') where storage_path like '%RFD-TEST-0001%'), '';
insert into t_results select 'the bucket is private', (select not public from storage.buckets where id = 'refund-proofs'), '';

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
