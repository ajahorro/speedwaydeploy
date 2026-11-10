-- Security cleanup from the Supabase security report.
-- 1. Trigger functions are never called directly; the database runs them for the table they belong to whatever the
--    caller's rights are. Nobody signed in or out needs to call them through the API.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
  loop execute format('revoke execute on function %s from public, anon, authenticated', f.sig); end loop;
end $$;

-- 2. Only a signed-in user can recover their own account or clear their own sign-in lock.
revoke execute on function public.recover_account() from public, anon;
revoke execute on function public.clear_login_lock(text) from public, anon;
grant execute on function public.recover_account() to authenticated, service_role;
grant execute on function public.clear_login_lock(text) to authenticated, service_role;

-- 3. A fixed search path, so these functions cannot be pointed at look-alike tables.
alter function public.backup_excluded_tables() set search_path = public;
alter function public.fill_service_name_snapshot() set search_path = public;
alter function public.login_client_key() set search_path = public;
alter function public.payment_gets_receipt(numeric, text, text) set search_path = public;
alter function public.profiles_role_is_fixed() set search_path = public;
