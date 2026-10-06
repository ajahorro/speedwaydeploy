-- Scratch-database test of staff_report: only an enabled staff account, only their own vehicles, no money. Rolled back.
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
insert into public.bookings (id, customer_id, customer_name, status, total_amount, start_datetime, end_datetime)
values ('98000000-0000-0000-0000-000000000001', :'cu', 'Report Test', 'confirmed', 1500, now(), now() + interval '1 hour');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, staff_id) values
 ('98000000-0000-0000-0000-0000000000a1', '98000000-0000-0000-0000-000000000001', 'Sedan', 'Toyota', 'Vios', 'RPT111', 'PENDING', :'sa'),
 ('98000000-0000-0000-0000-0000000000a2', '98000000-0000-0000-0000-000000000001', 'SUV', 'Honda', 'CRV', 'RPT222', 'PENDING', :'sb');
set local session_replication_role = origin;

create or replace function pg_temp.as_user(p_id uuid) returns void language sql as
$$ select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.try(p_name text, p_sql text, p_expect_error text default null)
returns void language plpgsql as $$
declare v_out text;
begin
  begin
    execute p_sql into v_out;
    insert into t_results values (p_name, p_expect_error is null, left(coalesce(v_out, ''), 80));
  exception when others then
    insert into t_results values (p_name, p_expect_error is not null and sqlerrm ilike '%' || p_expect_error || '%', sqlerrm);
  end;
end $$;

set local role authenticated;
select pg_temp.as_user(:'sa');
select pg_temp.try('switch off: refused', 'select public.staff_report()', 'not enabled');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
update public.profiles set can_view_reports = true where id = :'sa';
set local role authenticated;
select pg_temp.as_user(:'sa');
select pg_temp.try('switch on: allowed', 'select public.staff_report()');
select pg_temp.try('sees only their own vehicle', $$select (public.staff_report() -> 'schedule')::text not like '%RPT222%' and (public.staff_report() -> 'schedule')::text like '%RPT111%'$$);
select pg_temp.try('shows no money', $$select ((public.staff_report())::text !~* '(amount|price|paid|balance|peso|payment|fee)')$$);
select pg_temp.as_user(:'cu');
select pg_temp.try('customer refused', 'select public.staff_report()', 'not enabled');
select pg_temp.as_user(:'ad');
select pg_temp.try('administrator uses the full reports instead', 'select public.staff_report()', 'not enabled');
reset role;

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
