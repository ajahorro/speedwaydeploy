-- Scratch-database test: a promo code can be used once per account. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;
select id as ca from public.profiles where role = 'CUSTOMER' order by created_at limit 1 \gset
select id as cb from public.profiles where role = 'CUSTOMER' and id <> :'ca' order by created_at limit 1 \gset
select id as ad from public.profiles where role = 'ADMIN' order by created_at limit 1 \gset
insert into public.promo_codes (code, name, discount_type, discount_value, max_uses) values ('ONCE10', 'Once', 'percentage', 10, 5);

create or replace function pg_temp.book(p_customer uuid, p_day integer) returns text language plpgsql as $$
begin
  insert into public.bookings (customer_id, customer_name, status, total_amount, start_datetime, end_datetime, promo_code)
  values (p_customer, 'Once', 'confirmed', 100, date_trunc('day', now()) + make_interval(days => p_day, hours => 3), date_trunc('day', now()) + make_interval(days => p_day, hours => 4), 'once10');
  return 'booked';
exception when others then return sqlerrm;
end $$;
grant execute on function pg_temp.book(uuid, integer) to authenticated;

insert into t_results select 'the first use by an account works', pg_temp.book(:'ca', 20) = 'booked', '';
insert into t_results select 'the same account cannot use it twice', pg_temp.book(:'ca', 21) ilike '%already used%', pg_temp.book(:'ca', 22);
insert into t_results select 'another account can use it', pg_temp.book(:'cb', 23) = 'booked', '';
insert into t_results select 'the limit counts accounts', (select uses_count from public.promo_codes where code = 'ONCE10') = 2, '';

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ca', 'role', 'authenticated')::text, true);
insert into t_results select 'entering the code again says it was already used', (public.redeem_promo_code('once10') ->> 'reason') = 'already_used', '';
select set_config('request.jwt.claims', json_build_object('sub', :'ad', 'role', 'authenticated')::text, true);
insert into t_results select 'an admin booking for that account is told the same', (public.redeem_promo_code('once10', :'ca') ->> 'reason') = 'already_used', '';
insert into t_results select 'an admin booking for a new account can use it', (public.redeem_promo_code('once10', gen_random_uuid()) ->> 'valid')::boolean, '';
reset role;

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
