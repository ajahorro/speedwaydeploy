-- A staff member blocked from clocking out ("starts within 5 minutes/1 hour, nothing started yet")
-- or from being deactivated ("assigned to an active service") previously required an admin to
-- manually pick a replacement every time. That's only a real handoff problem for work that has
-- physically STARTED (IN_PROGRESS/ONGOING, or a before-photo already taken) — nothing to hand off
-- for work that hasn't begun, so that part is safe to reassign automatically. This function moves
-- only the not-yet-started bookings/vehicles to another active staff member; anything already
-- under way is left alone, and the existing blockers still fire for it exactly as before.
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
  -- shortcut: pick the active staff member (other than p_staff_id) with the fewest
  -- currently-active assignments; ties broken by name for determinism. Does not
  -- consider who is clocked in right now — upgrade if that turns out to matter.
  select pr.id into v_replacement
    from public.profiles pr
   where upper(coalesce(pr.role, '')) = 'STAFF'
     and coalesce(pr.is_active, true) = true
     and pr.id <> p_staff_id
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
     where bv.staff_id = p_staff_id
       and upper(coalesce(bv.status, '')) not in ('IN_PROGRESS', 'ONGOING', 'COMPLETED', 'CANCELLED')
       and not exists (select 1 from public.service_photos sp where sp.booking_vehicle_id = bv.id and sp.phase = 'before')
     returning 1
  )
  select count(*) into v_vehicles from moved;

  with moved as (
    update public.bookings b
       set staff_id = v_replacement
     where b.staff_id = p_staff_id
       and lower(coalesce(b.status, '')) not in ('in_progress', 'ongoing', 'completed', 'cancelled', 'flagged_noshow', 'no_show')
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
            format('Moved %s not-yet-started vehicle assignment(s) and %s booking lead assignment(s) from a staff member to another available technician.', v_vehicles, v_bookings));
  end if;

  return jsonb_build_object('replacement_id', v_replacement, 'reassigned_bookings', v_bookings, 'reassigned_vehicles', v_vehicles);
end;
$$;

revoke all on function public.auto_reassign_staff_pending_work(uuid) from public, anon, authenticated;
grant execute on function public.auto_reassign_staff_pending_work(uuid) to service_role;
