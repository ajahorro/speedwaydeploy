-- ============================================================================
-- Default staff account + emergency-only auto-reassignment refinement.
-- ============================================================================
--
-- POLICY (mirrors the existing default-admin protection)
--   * There is, and must remain, at least one protected "default" staff account
--     that can never be deactivated — the same guarantee the system already
--     gives the default admin. Today that is the shop's one existing staff
--     account; seeded once below, like default_admin_id was.
--   * On top of that single protected account, NO deactivation may ever leave
--     the system with zero active staff, the same invariant already enforced
--     for administrators.
--   * The default staff account is never picked as the automatic replacement
--     when another staff member's imminent work gets reassigned — it exists as
--     a guaranteed fallback, not a dumping ground for every handoff.
--
-- Also fixes auto_reassign_staff_pending_work: it was moving EVERY not-yet-
-- started booking off a staff member the moment they clocked out or were
-- deactivated, including bookings scheduled days out. A technician clocking
-- out for the day with a booking tomorrow could have that booking silently
-- handed to someone else even though nothing was actually at risk. The
-- function now only reassigns imminent work (starting within 4 hours) — a
-- genuine handoff emergency — and leaves anything further out with the
-- staff member for an admin to handle normally.
-- ============================================================================

-- -- 1. Default staff singleton, same mechanism as default_admin_id() ---------
insert into public.app_singletons (key, value)
select 'default_staff_id', id::text
  from public.profiles
 where upper(coalesce(role, '')) = 'STAFF'
 order by created_at asc
 limit 1
on conflict (key) do nothing;

create or replace function public.default_staff_id()
returns uuid
language sql stable
set search_path = public
as $$
  select nullif(value, '')::uuid from public.app_singletons where key = 'default_staff_id';
$$;

comment on function public.default_staff_id() is
  'The single protected default staff account. Can never be deactivated, and is never auto-picked as a reassignment target.';

-- -- 2. Guard: no staff deactivation may remove the default account or the ---
--    last remaining active staff member.
create or replace function public.deactivate_staff_account(p_account_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_other_active_staff integer;
begin
  select upper(coalesce(role, '')) into v_role from public.profiles where id = p_account_id;
  if v_role is null then raise exception 'Account not found.' using errcode = 'P0002'; end if;

  if v_role = 'STAFF' then
    if p_account_id = public.default_staff_id() then
      raise exception 'The Default Staff account cannot be deactivated.' using errcode = 'check_violation';
    end if;

    select count(*) into v_other_active_staff
      from public.profiles
     where id <> p_account_id
       and upper(coalesce(role, '')) = 'STAFF'
       and coalesce(is_active, true) = true;
    if v_other_active_staff = 0 then
      raise exception 'Cannot deactivate the last remaining staff account.' using errcode = 'check_violation';
    end if;
  end if;

  update public.profiles
     set is_active = false, deactivated_at = now(), staff_deactivated_at = now(),
         staff_deactivation_reason = coalesce(nullif(btrim(p_reason), ''), 'Deactivated by an administrator.'),
         updated_at = now()
   where id = p_account_id;
  if not found then raise exception 'Account not found.' using errcode = 'P0002'; end if;
  update auth.users set banned_until = now() + interval '100 years' where id = p_account_id;
end;
$$;

revoke all on function public.deactivate_staff_account(uuid, text) from public, anon, authenticated;
grant execute on function public.deactivate_staff_account(uuid, text) to service_role;

-- -- 3. auto_reassign_staff_pending_work: imminent work only, default staff --
--    excluded as a replacement target.
create or replace function public.auto_reassign_staff_pending_work(p_staff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_replacement uuid;
  v_vehicles integer := 0;
  v_bookings integer := 0;
begin
  select pr.id into v_replacement
    from public.profiles pr
   where upper(coalesce(pr.role, '')) = 'STAFF'
     and coalesce(pr.is_active, true) = true
     and pr.id <> p_staff_id
     and pr.id is distinct from public.default_staff_id()
   order by (
     select count(*) from public.booking_vehicles bv2
      where bv2.staff_id = pr.id and upper(coalesce(bv2.status, '')) not in ('COMPLETED', 'CANCELLED')
   ) asc, pr.full_name asc
   limit 1;

  if v_replacement is null then
    return jsonb_build_object('replacement_id', null, 'reassigned_bookings', 0, 'reassigned_vehicles', 0);
  end if;

  with moved as (
    update public.booking_vehicles bv
       set staff_id = v_replacement
      from public.bookings b
     where bv.booking_id = b.id
       and bv.staff_id = p_staff_id
       and upper(coalesce(bv.status, '')) not in ('IN_PROGRESS', 'ONGOING', 'COMPLETED', 'CANCELLED')
       and not exists (select 1 from public.service_photos sp where sp.booking_vehicle_id = bv.id and sp.phase = 'before')
       -- emergency only: starting soon, not some future day the staff member will simply be back for.
       and b.start_datetime <= now() + interval '4 hours'
     returning 1
  )
  select count(*) into v_vehicles from moved;

  with moved as (
    update public.bookings b
       set staff_id = v_replacement
     where b.staff_id = p_staff_id
       and lower(coalesce(b.status, '')) not in ('in_progress', 'ongoing', 'completed', 'cancelled', 'flagged_noshow', 'no_show')
       and b.start_datetime <= now() + interval '4 hours'
       and not exists (
         select 1 from public.booking_vehicles bv
          where bv.booking_id = b.id
            and (
              upper(coalesce(bv.status, '')) in ('IN_PROGRESS', 'ONGOING')
              or exists (select 1 from public.service_photos sp where sp.booking_vehicle_id = bv.id and sp.phase = 'before')
            )
       )
     returning 1
  )
  select count(*) into v_bookings from moved;

  if v_vehicles > 0 or v_bookings > 0 then
    insert into public.audit_logs (action_type, actor_name, actor_role, details)
    values ('STAFF_WORK_AUTO_REASSIGNED', 'System', 'SYSTEM',
            format('Moved %s imminent vehicle assignment(s) and %s imminent booking lead assignment(s) from a staff member to another available technician.', v_vehicles, v_bookings));
  end if;

  return jsonb_build_object('replacement_id', v_replacement, 'reassigned_bookings', v_bookings, 'reassigned_vehicles', v_vehicles);
end;
$$;

revoke all on function public.auto_reassign_staff_pending_work(uuid) from public, anon, authenticated;
grant execute on function public.auto_reassign_staff_pending_work(uuid) to service_role;
