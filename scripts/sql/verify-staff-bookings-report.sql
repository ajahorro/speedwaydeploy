-- Scratch-database test of staff_bookings_report: only an enabled staff account (or an administrator), the whole shop's
-- bookings, no money and no contact details, range limits. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
set local session_replication_role = replica;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;
select id as sa from public.profiles where role = 'STAFF' and is_active order by created_at limit 1 \gset
select id as sb from public.profiles where role = 'STAFF' and is_active and id <> :'sa' order by created_at limit 1 \gset
select id as cu from public.profiles where role = 'CUSTOMER' order by created_at limit 1 \gset
select id as ad from public.profiles where role = 'ADMIN' order by created_at limit 1 \gset
update public.profiles set can_view_reports = false where id in (:'sa', :'sb');
insert into public.bookings (id, customer_id, customer_name, status, total_amount, start_datetime, end_datetime, contact_number, customer_email)
values ('98100000-0000-0000-0000-000000000001', :'cu', 'Report Test', 'confirmed', 1500, now(), now() + interval '1 hour', '09171234567', 'secret@example.com');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, staff_id) values
 ('98100000-0000-0000-0000-0000000000a1', '98100000-0000-0000-0000-000000000001', 'Sedan', 'Toyota', 'Vios', 'SBR111', 'PENDING', :'sa'),
 ('98100000-0000-0000-0000-0000000000a2', '98100000-0000-0000-0000-000000000001', 'SUV', 'Honda', 'CRV', 'SBR222', 'PENDING', :'sb');
set local session_replication_role = origin;

create or replace function pg_temp.as_user(p_id uuid) returns void language sql as
$$ select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.try(p_name text, p_sql text, p_expect_error text default null)
returns void language plpgsql as $$
declare v_out text;
begin
  begin
    execute p_sql into v_out;
    insert into t_results values (p_name, p_expect_error is null and coalesce(v_out, 'true') <> 'false', left(coalesce(v_out, ''), 80));
  exception when others then
    insert into t_results values (p_name, p_expect_error is not null and sqlerrm ilike '%' || p_expect_error || '%', sqlerrm);
  end;
end $$;

set local role authenticated;
select pg_temp.as_user(:'sa');
select pg_temp.try('switch off: refused', $$select public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day')$$, 'not enabled');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
update public.profiles set can_view_reports = true where id = :'sa';
set local role authenticated;
select pg_temp.as_user(:'sa');
select pg_temp.try('switch on: allowed', $$select public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day')$$);
select pg_temp.try('sees the whole shop, including another technician''s vehicle', $$select (public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day'))::text like '%SBR222%' and (public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day'))::text like '%SBR111%'$$);
select pg_temp.try('shows no money or contact details', $$select ((public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day'))::text !~* '(amount|price|paid|balance|peso|payment|fee|refund|09171234567|secret@example|contact|email)')$$);
select pg_temp.try('counts the booking and its two vehicles', $$select (public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day') -> 'totals' ->> 'bookings')::int >= 1 and (public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day') -> 'totals' ->> 'vehicles')::int >= 2$$);
select pg_temp.try('range over 93 days refused', $$select public.staff_bookings_report(now() - interval '100 days', now())$$, 'too long');
select pg_temp.try('empty range refused', $$select public.staff_bookings_report(now(), now())$$, 'valid date range');
select pg_temp.as_user(:'cu');
select pg_temp.try('customer refused', $$select public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day')$$, 'not enabled');
select pg_temp.as_user(:'sb');
select pg_temp.try('staff with the switch off refused', $$select public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day')$$, 'not enabled');
select pg_temp.as_user(:'ad');
select pg_temp.try('administrator allowed', $$select public.staff_bookings_report(now() - interval '1 day', now() + interval '1 day')$$);
reset role;

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
