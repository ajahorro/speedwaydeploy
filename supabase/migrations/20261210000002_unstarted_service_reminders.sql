-- A technician sends the before photo (intake done) but never presses "Start service". The booking then sits as
-- Confirmed until the no-show sweep flags it an hour after its scheduled time.
--
-- This reminds people while there is still time to act, once per booking:
--   * the technician(s) on the booking: "Start the service now" (opens their task list)
--   * every active administrator: "Intake is done but the service has not started" (opens the booking)
-- It runs as part of the same 5-minute sweep as the no-show check, after it, so a booking that has just been
-- flagged is never reminded. A problem in the reminders never stops the no-show sweep.

create or replace function public.remind_unstarted_services(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count integer := 0;
  v_added integer;
  v_ref text;
begin
  for v_row in
    select b.id, b.start_datetime
      from public.bookings b
     where lower(coalesce(b.status::text, '')) in ('confirmed', 'scheduled')
       and b.start_datetime <= p_now
       and exists (select 1 from public.service_photos sp where sp.booking_id = b.id and sp.phase = 'before')
  loop
    v_ref := upper(left(v_row.id::text, 8));

    -- the technician(s) on this booking
    insert into public.notifications (user_id, title, message, notification_type, action_url, is_read, booking_id)
    select t.staff_id,
           'Start the service now',
           'The before photos for #' || v_ref || ' are in and its service time has arrived. Press Start service now, or it will be marked a no-show.',
           'START_SERVICE_PROMPT', '/staff/tasks', false, v_row.id
      from (
        select b.staff_id from public.bookings b where b.id = v_row.id and b.staff_id is not null
        union
        select bv.staff_id from public.booking_vehicles bv where bv.booking_id = v_row.id and bv.staff_id is not null
      ) t
     where not exists (
       select 1 from public.notifications n
        where n.user_id = t.staff_id and n.booking_id = v_row.id and n.notification_type = 'START_SERVICE_PROMPT'
     );
    get diagnostics v_added = row_count;
    v_count := v_count + v_added;

    -- the administrators
    insert into public.notifications (user_id, title, message, notification_type, action_url, is_read, booking_id)
    select p.id,
           'Intake done, service not started',
           'Booking #' || v_ref || ' has its before photos but the service has not been started. It becomes a no-show an hour after its scheduled time.',
           'UNSTARTED_SERVICE', '/admin/bookings/' || v_row.id, false, v_row.id
      from public.profiles p
     where upper(coalesce(p.role, '')) = 'ADMIN' and coalesce(p.is_active, true)
       and not exists (
         select 1 from public.notifications n
          where n.user_id = p.id and n.booking_id = v_row.id and n.notification_type = 'UNSTARTED_SERVICE'
       );
  end loop;
  return v_count;
end;
$$;

revoke all on function public.remind_unstarted_services(timestamptz) from public, anon, authenticated;
grant execute on function public.remind_unstarted_services(timestamptz) to service_role;

create or replace function public.run_no_show_lifecycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flagged integer;
  v_cancelled integer;
  v_reminded integer := 0;
begin
  v_flagged := public.flag_no_show_bookings(interval '1 hour', now());
  v_cancelled := public.close_expired_no_show_windows(now());
  begin
    v_reminded := public.remind_unstarted_services(now());
  exception when others then
    raise warning 'unstarted-service reminders failed: %', sqlerrm;
  end;

  return jsonb_build_object(
    'flagged', v_flagged,
    'cancelled', v_cancelled,
    'reminded', v_reminded,
    'ran_at', now()
  );
end;
$$;
