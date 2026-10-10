-- ============================================================================
-- Account roles are fixed, and a deactivated account is deleted for good after the grace period.
--
--   * A customer, staff and admin account each stay what they were created as. A role can never be changed
--     (not customer -> staff, not staff -> admin, not back).
--   * Deactivating a staff or admin account no longer turns it into a customer account. It is switched off
--     (is_active = false), its sign-in is blocked, and only an administrator can bring it back in the grace period.
--   * Any deactivated account (customer, staff or admin) is permanently deleted from the database once the grace
--     period (business_config.account_recovery_grace_days, 15 days) has passed.
-- ============================================================================

-- 0. Accounts that an earlier version turned into customers when it deactivated them become deactivated staff
--    accounts again (their grace period starts now). Done before the role lock below is installed.
update public.profiles
   set role = 'STAFF', is_active = false, deactivated_at = now()
 where staff_deactivated_at is not null and upper(coalesce(role, '')) = 'CUSTOMER';

-- 1. A role never changes.
create or replace function public.profiles_role_is_fixed()
returns trigger
language plpgsql
as $$
begin
  if upper(coalesce(new.role, '')) is distinct from upper(coalesce(old.role, '')) then
    raise exception 'An account keeps the role it was created with (customer, staff or administrator).'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_profiles_role_is_fixed on public.profiles;
create trigger trg_profiles_role_is_fixed
  before update of role on public.profiles
  for each row execute function public.profiles_role_is_fixed();

drop function if exists public.elevate_profile_role(text, text, text, text, uuid);

-- 2. A technician with active work cannot be deactivated (this used to be enforced by the role change).
create or replace function public.prevent_staff_deactivation_during_service()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if upper(coalesce(old.role, '')) = 'STAFF' and coalesce(old.is_active, true) and new.is_active is false
     and public.staff_has_active_services(old.id) then
    raise exception 'This staff account cannot be deactivated while assigned to an active service.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_prevent_staff_deactivation_during_service on public.profiles;
create trigger trg_prevent_staff_deactivation_during_service
  before update of is_active on public.profiles
  for each row execute function public.prevent_staff_deactivation_during_service();

-- A deactivated account has no staff or admin powers, even on a session that is still open.
create or replace function public.is_admin_or_staff()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.profiles
     where id = auth.uid() and role in ('ADMIN', 'STAFF') and coalesce(is_active, true)
  );
end;
$$;

-- 3. Deactivate / reactivate a staff or admin account (service role; the server checks who is asking).
create or replace function public.deactivate_staff_account(p_account_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grace integer;
begin
  select coalesce(account_recovery_grace_days, 15) into v_grace from public.business_config order by id limit 1;
  update public.profiles
     set is_active = false,
         deactivated_at = now(),
         staff_deactivated_at = now(),
         staff_deactivation_reason = coalesce(nullif(btrim(p_reason), ''), 'Deactivated by an administrator.'),
         updated_at = now()
   where id = p_account_id and upper(coalesce(role, '')) in ('STAFF', 'ADMIN');
  if not found then raise exception 'Staff or administrator account not found.' using errcode = 'P0002'; end if;
  -- no new sign-in while the account waits to be deleted or reactivated
  update auth.users set banned_until = now() + make_interval(days => coalesce(v_grace, 15) + 1) where id = p_account_id;
end;
$$;

create or replace function public.reactivate_staff_account(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grace integer;
  p public.profiles%rowtype;
begin
  select coalesce(account_recovery_grace_days, 15) into v_grace from public.business_config order by id limit 1;
  select * into p from public.profiles where id = p_account_id for update;
  if not found or coalesce(p.is_active, true) or p.staff_deactivated_at is null
     or upper(coalesce(p.role, '')) not in ('STAFF', 'ADMIN') then
    raise exception 'This account was not deactivated.' using errcode = 'P0002';
  end if;
  if p.deactivated_at is not null and p.deactivated_at < now() - make_interval(days => coalesce(v_grace, 15)) then
    raise exception 'The recovery period for this account has ended.' using errcode = 'check_violation';
  end if;
  -- a fresh joined date, so the inactivity period starts again
  update public.profiles
     set is_active = true, deactivated_at = null, staff_deactivated_at = null, staff_deactivation_reason = null,
         hired_at = current_date, updated_at = now()
   where id = p_account_id;
  update auth.users set banned_until = null where id = p_account_id;
end;
$$;

revoke all on function public.deactivate_staff_account(uuid, text) from public, anon, authenticated;
revoke all on function public.reactivate_staff_account(uuid) from public, anon, authenticated;
grant execute on function public.deactivate_staff_account(uuid, text) to service_role;
grant execute on function public.reactivate_staff_account(uuid) to service_role;

-- 4. Automatic deactivation of inactive staff now switches the account off instead of making it a customer.
do $patch$
declare
  v_def text;
begin
  select pg_get_functiondef('public.deactivate_inactive_staff()'::regprocedure) into v_def;
  if position('deactivate_staff_account' in v_def) > 0 then return; end if;
  v_def := replace(v_def,
    E'    update public.profiles\n       set role = ''CUSTOMER'',\n           staff_deactivated_at = now(),\n           staff_deactivation_reason = format(''No sign-in for %s %s (last activity %s).'', v_after, v_unit, to_char(r.activity, ''YYYY-MM-DD''))\n     where id = r.id;',
    E'    perform public.deactivate_staff_account(r.id, format(''No sign-in for %s %s (last activity %s).'', v_after, v_unit, to_char(r.activity, ''YYYY-MM-DD'')));');
  v_def := replace(v_def, 'The account is now a customer account; an administrator can reactivate it.', 'The account is switched off; an administrator can reactivate it before it is deleted.');
  if position('deactivate_staff_account' in v_def) = 0 then
    raise exception 'deactivate_inactive_staff layout changed; patch not installed';
  end if;
  execute v_def;
end
$patch$;

-- 5. Only a customer can recover their own deactivated account; staff and administrators need an administrator.
do $patch$
declare
  v_def text;
begin
  select pg_get_functiondef('public.recover_account()'::regprocedure) into v_def;
  if position('ADMIN_ONLY' in v_def) > 0 then return; end if;
  v_def := replace(v_def,
    E'  if coalesce(v_profile.is_active, true) then',
    E'  if upper(coalesce(v_profile.role, '''')) <> ''CUSTOMER'' then\n    raise exception ''ADMIN_ONLY: a staff or administrator account can only be reactivated by an administrator.'' using errcode = ''42501'';\n  end if;\n\n  if coalesce(v_profile.is_active, true) then');
  if position('ADMIN_ONLY' in v_def) = 0 then raise exception 'recover_account layout changed; patch not installed'; end if;
  execute v_def;
end
$patch$;

-- 6. Permanent deletion. Anything that points at the account and would block its deletion is detached first
--    (a nullable reference is cleared, a required one is removed with its row); the account's own data (bookings,
--    vehicles, chats, notifications, drafts, credits ...) goes with it through the cascading references.
create or replace function public.purge_deactivated_accounts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grace integer;
  r record;
  c record;
  v_count integer := 0;
begin
  select coalesce(account_recovery_grace_days, 15) into v_grace from public.business_config order by id limit 1;

  for r in
    select id, email, upper(coalesce(role, '')) as role
      from public.profiles
     where coalesce(is_active, true) = false
       and deactivated_at is not null
       and deactivated_at < now() - make_interval(days => coalesce(v_grace, 15))
  loop
    begin
      for c in
        select con.conrelid::regclass as tbl, a.attname as col, a.attnotnull as required
          from pg_constraint con
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
         where con.contype = 'f'
           and con.confdeltype in ('a', 'r')
           and con.confrelid in ('public.profiles'::regclass, 'auth.users'::regclass)
           and con.connamespace = 'public'::regnamespace
      loop
        if c.required then
          execute format('delete from %s where %I = $1', c.tbl, c.col) using r.id;
        else
          execute format('update %s set %I = null where %I = $1', c.tbl, c.col, c.col) using r.id;
        end if;
      end loop;

      -- data kept by a plain id (no foreign key) is removed or made anonymous here
      delete from public.vehicles where owner_id = r.id;
      delete from public.notifications where user_id = r.id;
      delete from public.staff_shifts where staff_id = r.id;
      update public.audit_logs set actor_id = null, actor_name = 'Deleted account' where actor_id = r.id;
      update public.audit_trails set actor_id = null where actor_id = r.id;
      update public.booking_events set actor_id = null where actor_id = r.id;
      if r.email is not null then
        delete from public.invites where lower(email) = lower(r.email);
      end if;

      delete from auth.users where id = r.id;  -- the profile and the account's own data follow by cascade
      v_count := v_count + 1;

      insert into public.audit_logs (action_type, actor_name, actor_role, details)
      values ('ACCOUNT_PURGED', 'System', 'SYSTEM',
              format('A deactivated %s account was permanently deleted after the %s-day recovery period.', lower(r.role), coalesce(v_grace, 15)));
    exception when others then
      insert into public.audit_logs (action_type, actor_name, actor_role, details)
      values ('ACCOUNT_PURGE_FAILED', 'System', 'SYSTEM',
              format('A deactivated %s account could not be deleted yet: %s', lower(r.role), sqlerrm));
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.purge_deactivated_accounts() from public, anon, authenticated;
grant execute on function public.purge_deactivated_accounts() to service_role;
