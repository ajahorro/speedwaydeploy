-- Security Advisor (Part 6): SECURITY DEFINER trigger functions were still executable through the
-- API by anon/authenticated. A trigger function is never called by a client: Postgres only checks
-- EXECUTE when a trigger is created, not when it fires, so revoking it changes nothing about how
-- the triggers behave and removes them from the callable API surface. Non-trigger functions are
-- untouched (login lock, registration invite lookup, admin checks and the RPCs the app calls).
do $$
declare
  f record;
  n integer := 0;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prosecdef
       and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    n := n + 1;
  end loop;
  raise notice 'revoked EXECUTE on % trigger functions', n;
end
$$;
