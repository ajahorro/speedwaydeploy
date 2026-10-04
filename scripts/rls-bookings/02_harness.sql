-- Scratch-only test helpers (local throwaway DB).
create schema if not exists rlst;
grant usage on schema rlst to anon, authenticated, service_role;

-- Run a statement as the CURRENT role; report rows affected or the SQLSTATE.
-- The statement is always undone (sub-transaction rollback) so checks stay
-- independent of each other.
create or replace function rlst.try_sql(p_sql text) returns text
language plpgsql security invoker as $$
declare n bigint;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
    raise exception using errcode = 'RLST0', message = n::text;
  exception when others then
    if sqlstate = 'RLST0' then
      return 'ok:' || sqlerrm;
    end if;
    return 'err:' || sqlstate;
  end;
end $$;

-- Return the first column of a query as text, or the SQLSTATE.
create or replace function rlst.val(p_sql text) returns text
language plpgsql security invoker as $$
declare v text;
begin
  execute p_sql into v;
  return coalesce(v, '<null>');
exception when others then
  return 'err:' || sqlstate;
end $$;

create or replace function rlst.chk(p_name text, p_actual text, p_expected text) returns text
language sql immutable as $$
  select case when p_actual is not distinct from p_expected
              then 'PASS  ' || p_name
              else 'FAIL  ' || p_name || '  got=' || coalesce(p_actual, '<null>') || '  expected=' || coalesce(p_expected, '<null>') end
$$;

grant execute on all functions in schema rlst to anon, authenticated, service_role;
