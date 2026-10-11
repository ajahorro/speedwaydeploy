-- Scratch-database test: a customer who overpaid asks for the excess back while the booking is still going ahead.
-- The booking keeps its status, the excess reaches the Refund Hub, an administrator refunds it (cash needs no proof,
-- a bank transfer does), and nobody can use it on someone else's booking. Rolled back.
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
select pg_temp.mk('9c100000-0000-0000-0000-000000000001', 'ex-cust@test.local', 'CUSTOMER');
select pg_temp.mk('9c100000-0000-0000-0000-000000000002', 'ex-cust2@test.local', 'CUSTOMER');
select pg_temp.mk('9c100000-0000-0000-0000-000000000003', 'ex-admin@test.local', 'ADMIN');

set local session_replication_role = replica;
insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime) values
 ('9c1000aa-0000-0000-0000-000000000001', '9c100000-0000-0000-0000-000000000001', 'E X', 'in_progress', 'paid', 500, now(), now() + interval '1 hour'),
 ('9c1000aa-0000-0000-0000-000000000002', '9c100000-0000-0000-0000-000000000001', 'E X', 'confirmed', 'paid', 500, now() + interval '2 days', now() + interval '2 days 1 hour');
set local session_replication_role = origin;
insert into public.payments (booking_id, amount, method, payment_type, status, reference_number) values
 ('9c1000aa-0000-0000-0000-000000000001', 800, 'GCash', 'Full', 'PAID', 'EXPAY000111'),
 ('9c1000aa-0000-0000-0000-000000000002', 800, 'GCash', 'Full', 'PAID', 'EXPAY000222');

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

insert into t_results select 'the overpayment is held as excess on the booking', public.customer_booking_excess_credit('9c100000-0000-0000-0000-000000000001', '9c1000aa-0000-0000-0000-000000000001') = 300, public.customer_booking_excess_credit('9c100000-0000-0000-0000-000000000001', '9c1000aa-0000-0000-0000-000000000001')::text;

-- another customer cannot ask on this booking
select pg_temp.as_user('9c100000-0000-0000-0000-000000000002');
select pg_temp.try('another customer cannot request the refund', $$select public.request_excess_refund('9c1000aa-0000-0000-0000-000000000001')$$, 'own booking');

-- the customer asks while the booking is in progress
select pg_temp.as_user('9c100000-0000-0000-0000-000000000001');
create temp table t_req on commit drop as select public.request_excess_refund('9c1000aa-0000-0000-0000-000000000001') as r;
grant all on t_req to public;
insert into t_results select 'the excess is queued for the Refund Hub', (select (r ->> 'routed')::numeric from t_req) = 300, (select r::text from t_req);
insert into t_results select 'the booking keeps its status', (select status from public.bookings where id = '9c1000aa-0000-0000-0000-000000000001') = 'in_progress', '';
insert into t_results select 'the booking shows as a queued refund', (select refund_status from public.bookings where id = '9c1000aa-0000-0000-0000-000000000001') = 'QUEUED', '';
insert into t_results select 'asking again queues nothing more', (public.request_excess_refund('9c1000aa-0000-0000-0000-000000000001') ->> 'routed')::numeric = 0, '';
select pg_temp.as_service();
insert into t_results select 'the administrators are told', exists (select 1 from public.notifications where booking_id = '9c1000aa-0000-0000-0000-000000000001' and notification_type = 'EXCESS_REFUND_REQUESTED'), '';

-- the administrator refunds it: a bank transfer needs its proof, cash does not
select pg_temp.as_user('9c100000-0000-0000-0000-000000000003');
select pg_temp.try('a bank transfer excess refund needs its proof', $$select public.process_overpayment_credit_refund_v2('9c1000aa-0000-0000-0000-000000000001', 300, 'Excess payment', 'RFD-EX-0001', 'BANK TRANSFER', '9c100000-0000-0000-0000-000000000003')$$, 'REFUND_PROOF_REQUIRED');
select public.process_overpayment_credit_refund_v2('9c1000aa-0000-0000-0000-000000000001', 300, 'Excess payment', 'RFD-EX-0002', 'CASH', '9c100000-0000-0000-0000-000000000003');
insert into t_results select 'a cash excess refund goes through on an in-progress booking', exists (select 1 from public.payments where booking_id = '9c1000aa-0000-0000-0000-000000000001' and method = 'SYSTEM_REFUND' and reference_number = 'RFD-EX-0002' and refund_method = 'CASH'), '';
insert into t_results select 'and the booking is still in progress', (select status from public.bookings where id = '9c1000aa-0000-0000-0000-000000000001') = 'in_progress', '';
insert into t_results select 'the refund is marked processed', (select refund_status from public.bookings where id = '9c1000aa-0000-0000-0000-000000000001') = 'PROCESSED', '';

-- an excess refund is not allowed on a cancelled booking (that is refunded from everything paid)
select pg_temp.as_service();
set local session_replication_role = replica;
update public.bookings set status = 'cancelled' where id = '9c1000aa-0000-0000-0000-000000000002';
set local session_replication_role = origin;
select pg_temp.as_user('9c100000-0000-0000-0000-000000000001');
select pg_temp.try('a cancelled booking cannot request an excess refund', $$select public.request_excess_refund('9c1000aa-0000-0000-0000-000000000002')$$, 'cancelled');

select pg_temp.as_service();
select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
