-- ============================================================================
-- Automatic sign-out after inactivity: administrator and staff sign-outs are written to the audit log.
-- Called by the signed-in browser just before it signs the user out. It only ever records the caller's own
-- sign-out, and only for staff and administrator accounts.
-- ============================================================================
create or replace function public.record_idle_signout()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_profile public.profiles%rowtype;
begin
  if auth.uid() is null then return; end if;
  select * into v_profile from public.profiles where id = auth.uid();
  if not found or upper(coalesce(v_profile.role::text, '')) not in ('ADMIN', 'STAFF') then return; end if;
  insert into public.audit_logs (action_type, actor_name, actor_role, actor_id, details)
  values ('IDLE_SIGNOUT',
          coalesce(nullif(btrim(v_profile.full_name), ''), v_profile.email, 'Account'),
          upper(v_profile.role::text), v_profile.id,
          format('%s was signed out automatically after a period of inactivity.', coalesce(nullif(btrim(v_profile.full_name), ''), v_profile.email, 'The account')));
end;
$fn$;
revoke all on function public.record_idle_signout() from public, anon;
grant execute on function public.record_idle_signout() to authenticated;
