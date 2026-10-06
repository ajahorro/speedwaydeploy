-- ============================================================================
-- Automatic deactivation of inactive STAFF accounts.
--
--   * The administrator chooses, on the Staff Roles page, whether it is on and after how many days or
--     months without signing in a staff account is deactivated (default: off).
--   * "Inactive" means no sign-in for that long. An account that was never signed in counts from the day
--     it became a staff account (its "joined" date), so a new or just-reactivated account gets a full period.
--   * Deactivation here is the same as the administrator's own Deactivate button: the account goes back to a
--     customer account (history and bookings are kept). It is recorded in the audit log, and marked so the
--     administrator can see it and reactivate it. Only an administrator can reactivate.
--   * A staff account with active work is never deactivated; administrators are never touched.
-- ============================================================================
alter table public.business_config
  add column if not exists staff_auto_deactivate_enabled boolean not null default false,
  add column if not exists staff_auto_deactivate_after integer not null default 90,
  add column if not exists staff_auto_deactivate_unit text not null default 'days';

alter table public.business_config drop constraint if exists business_config_staff_auto_deactivate_check;
alter table public.business_config add constraint business_config_staff_auto_deactivate_check
  check (staff_auto_deactivate_after between 1 and 3650 and staff_auto_deactivate_unit in ('days', 'months'));

alter table public.profiles
  add column if not exists staff_deactivated_at timestamptz,
  add column if not exists staff_deactivation_reason text;

create or replace function public.deactivate_inactive_staff()
returns table (profile_id uuid, email text, last_activity timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_after integer;
  v_unit text;
  v_cutoff timestamptz;
  r record;
begin
  select staff_auto_deactivate_enabled, staff_auto_deactivate_after, staff_auto_deactivate_unit
    into v_enabled, v_after, v_unit
    from public.business_config order by id limit 1;
  if not coalesce(v_enabled, false) then return; end if;

  v_cutoff := now() - case when v_unit = 'months' then make_interval(months => v_after) else make_interval(days => v_after) end;

  for r in
    select p.id, p.email, p.full_name,
           greatest(
             coalesce(u.last_sign_in_at, '-infinity'::timestamptz),
             coalesce(p.hired_at::timestamptz, '-infinity'::timestamptz),
             case when u.last_sign_in_at is null and p.hired_at is null then coalesce(p.created_at, now()) else '-infinity'::timestamptz end
           ) as activity
      from public.profiles p
      left join auth.users u on u.id = p.id
     where upper(p.role) = 'STAFF'
       and coalesce(p.is_active, true)
  loop
    continue when r.activity >= v_cutoff;
    continue when public.staff_has_active_services(r.id);

    update public.profiles
       set role = 'CUSTOMER',
           staff_deactivated_at = now(),
           staff_deactivation_reason = format('No sign-in for %s %s (last activity %s).', v_after, v_unit, to_char(r.activity, 'YYYY-MM-DD'))
     where id = r.id;

    insert into public.audit_logs (action_type, actor_name, actor_role, details)
    values ('AUTO_DEACTIVATE_STAFF', 'System', 'SYSTEM',
            format('Staff account %s (%s) was deactivated automatically: no sign-in for %s %s. The account is now a customer account; an administrator can reactivate it.',
                   coalesce(r.full_name, 'Unnamed'), r.email, v_after, v_unit));

    profile_id := r.id; email := r.email; last_activity := r.activity;
    return next;
  end loop;
end;
$$;
revoke all on function public.deactivate_inactive_staff() from public, anon, authenticated;
grant execute on function public.deactivate_inactive_staff() to service_role;
