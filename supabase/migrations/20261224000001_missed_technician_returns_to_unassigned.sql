-- When a booking's time arrives and its technician is not clocked in, the booking goes back to Unassigned.
--
-- This is the one case where a booking steps back (a technician missing their shift cannot be helped):
--   * the technician who is not clocked in is taken off the booking (only where they have not saved a "before"
--     photo yet; a started job stays with them and is handled as before);
--   * the booking keeps its status (Confirmed / Scheduled) and payment; no email goes out to anyone;
--   * every administrator gets an in-app notification, and the technician is told in the app they were taken off;
--   * the booking is marked technician_missed_at, so the no-show sweep never blames the customer for it. The
--     administrator can still reassign it, flag it as a no-show, cancel it or refund it as usual.
-- The "Off shift" list in the Booking Directory is gone: these bookings now show under Unassigned.

alter table public.bookings add column if not exists technician_missed_at timestamptz;

-- the no-show sweep leaves these bookings alone (the customer did not miss it; the shop did)
create or replace function public.booking_staff_missed(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.bookings b where b.id = p_booking_id and b.technician_missed_at is not null)
      or exists (select 1 from public.service_photos sp where sp.booking_id = p_booking_id and sp.phase = 'before')
      or exists (
        select 1
          from (
            select b.staff_id from public.bookings b where b.id = p_booking_id and b.staff_id is not null
            union
            select bv.staff_id from public.booking_vehicles bv where bv.booking_id = p_booking_id and bv.staff_id is not null
          ) t
          join public.profiles p on p.id = t.staff_id
         where not coalesce(p.is_clocked_in, false)
      )
$$;
revoke all on function public.booking_staff_missed(uuid) from public, anon, authenticated;
grant execute on function public.booking_staff_missed(uuid) to service_role;

-- run by the lifecycle sweep (run_no_show_lifecycle) every few minutes; same name, so the sweep needs no change
create or replace function public.alert_off_shift_assignments(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_count integer := 0;
  v_removed integer;
  v_ref text;
begin
  for r in
    select distinct b.id as booking_id, t.staff_id, coalesce(nullif(trim(p.full_name), ''), p.email, 'A technician') as staff_name
      from public.bookings b
      join lateral (
        select b.staff_id as staff_id where b.staff_id is not null
        union
        select bv.staff_id from public.booking_vehicles bv where bv.booking_id = b.id and bv.staff_id is not null
      ) t on true
      join public.profiles p on p.id = t.staff_id
     where lower(coalesce(b.status::text, '')) in ('confirmed', 'scheduled')
       and b.start_datetime <= p_now
       and not coalesce(p.is_clocked_in, false)
       -- a technician who already saved a "before" photo has started; leave that booking with them
       and not exists (select 1 from public.service_photos sp
                        where sp.booking_id = b.id and sp.phase = 'before' and sp.uploaded_by = t.staff_id and sp.archived_at is null)
  loop
    v_ref := upper(left(r.booking_id::text, 8));
    v_removed := 0;
    begin
      update public.booking_vehicles set staff_id = null
       where booking_id = r.booking_id and staff_id = r.staff_id;
      get diagnostics v_removed = row_count;
      -- a booking without vehicle rows carries the technician on the booking itself
      update public.bookings set staff_id = null where id = r.booking_id and staff_id = r.staff_id;
      update public.bookings set technician_missed_at = coalesce(technician_missed_at, p_now) where id = r.booking_id;
    exception when others then
      raise warning 'alert_off_shift_assignments: booking % not returned to unassigned: %', r.booking_id, sqlerrm;
      continue;
    end;

    insert into public.notifications (user_id, title, message, notification_type, action_url, is_read, booking_id)
    values (r.staff_id, 'Removed from a booking',
            'Booking #' || v_ref || ' reached its time while you were not clocked in, so it was returned to the team to reassign.',
            'OFF_SHIFT_PROMPT', '/staff/duty', false, r.booking_id);

    insert into public.notifications (user_id, title, message, notification_type, action_url, is_read, booking_id)
    select p.id, 'Booking back to Unassigned',
           'Booking #' || v_ref || ' reached its time but ' || r.staff_name || ' was not clocked in, so it is back in Unassigned. '
             || 'Assign another technician, or flag it as a no-show, cancel or refund it if needed.',
           'OFF_SHIFT_ASSIGNMENT', '/admin/bookings/' || r.booking_id, false, r.booking_id
      from public.profiles p
     where upper(coalesce(p.role, '')) = 'ADMIN' and coalesce(p.is_active, true);

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.alert_off_shift_assignments(timestamptz) from public, anon, authenticated;
grant execute on function public.alert_off_shift_assignments(timestamptz) to service_role;
