-- Calls every function a signed-in or signed-out visitor is allowed to execute, with throw-away arguments, as each tier,
-- and shows what happens. Read the result: anything that is not refused for a non-administrator, and does something
-- other than "not found", deserves a look. Rolled back; nothing is kept.
--   docker exec -i <db> psql -U postgres -tA -F '|' < scripts/sql/probe-function-access.sql
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create temp table probe_out (tier text, fn text, outcome text);
grant all on probe_out to public;

create or replace function pg_temp.mk(p_id uuid, p_email text, p_role text) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, 'x', now(), jsonb_build_object('role', p_role), now(), now()) on conflict (id) do nothing;
  insert into public.profiles (id, email, first_name, last_name, full_name, role, is_active)
  values (p_id, p_email, 'T', 'T', 'T T', p_role, true) on conflict (id) do update set role = excluded.role, is_active = true;
end $$;
select pg_temp.mk('9b100000-0000-0000-0000-000000000001', 'pr-cust@test.local', 'CUSTOMER');
select pg_temp.mk('9b100000-0000-0000-0000-000000000002', 'pr-staff@test.local', 'STAFF');

create or replace function pg_temp.literal(p_type text) returns text language sql as $$
  select case p_type
    when 'uuid' then quote_literal('9b1fffff-0000-0000-0000-000000000099') || '::uuid'
    when 'text' then quote_literal('x')
    when 'numeric' then '1::numeric'
    when 'integer' then '1'
    when 'bigint' then '1'
    when 'boolean' then 'false'
    when 'jsonb' then quote_literal('{}') || '::jsonb'
    when 'timestamp with time zone' then 'now()'
    when 'date' then 'current_date'
    when 'interval' then quote_literal('1 hour') || '::interval'
    when 'uuid[]' then 'array[]::uuid[]'
    when 'text[]' then 'array[]::text[]'
    else 'null'
  end
$$;

create or replace function pg_temp.run_tier(p_tier text, p_uid uuid) returns void language plpgsql as $$
declare
  f record; v_args text; v_sql text; v_out text;
begin
  for f in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as ident, p.proargtypes
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
       and p.prorettype <> 'trigger'::regtype
       and has_function_privilege(case when p_tier = 'anon' then 'anon' else 'authenticated' end, p.oid, 'execute')
     order by p.proname
  loop
    select string_agg(pg_temp.literal(format_type(t, null)), ', ' order by o) into v_args
      from unnest(f.proargtypes::oid[]) with ordinality as a(t, o);
    v_sql := format('select public.%I(%s)', f.proname, coalesce(v_args, ''));
    begin
      perform set_config('request.jwt.claims', case when p_uid is null then '{"role":"anon"}' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
      execute case when p_tier = 'anon' then 'set local role anon' else 'set local role authenticated' end;
      execute v_sql;
      v_out := 'RAN';
    exception when others then
      v_out := left(regexp_replace(sqlerrm, '\s+', ' ', 'g'), 90);
    end;
    execute 'reset role';
    insert into probe_out values (p_tier, f.proname || '(' || f.ident || ')', v_out);
  end loop;
end $$;

select pg_temp.run_tier('anon', null);
select pg_temp.run_tier('customer', '9b100000-0000-0000-0000-000000000001');
select pg_temp.run_tier('staff', '9b100000-0000-0000-0000-000000000002');

-- what each tier could simply run (not refused)
select tier || '|' || fn || '|' || outcome from probe_out where outcome = 'RAN' order by tier, fn;
rollback;
