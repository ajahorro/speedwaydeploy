-- A booking is not the customer's no-show when the shop's own technician is the one who missed it.
--
--   * Not flagged as a no-show (so its payment is not queued for refund) when
--       - the technician already saved a before photo (the customer was there; the work simply was not started), or
--       - a technician assigned to it is not clocked in once the booking time has arrived (off shift).
--     Such a booking stays open for the administrator to reassign, start or, if it really was the customer, flag.
--   * Once the booking time has arrived and an assigned technician is off shift, that technician and every
--     administrator are told once, and the dashboard counts it (off_shift_assignments()).
--   * Bookings nobody was assigned to, and bookings whose technician is on shift but never started with no before photo,
--     are handled as before.

create or replace function public.booking_staff_missed(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.service_photos sp where sp.booking_id = p_booking_id and sp.phase = 'before')
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

-- 1. the sweep leaves those bookings alone
do $patch$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.flag_no_show_bookings(interval,timestamptz)'::regprocedure) into v_def;
  if v_def not like '%booking_staff_missed%' then
    v_new := regexp_replace(v_def, 'and start_datetime <= v_cutoff', E'and start_datetime <= v_cutoff\n       and not public.booking_staff_missed(id)');
    if v_new = v_def then raise exception 'flag_no_show_bookings layout changed; patch not applied'; end if;
    execute v_new;
  end if;
end
$patch$;

-- 2. technician and administrators are told when an assigned technician is off shift as the booking time arrives
create or replace function public.alert_off_shift_assignments(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_count integer := 0;
  v_added integer;
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
  loop
    v_ref := upper(left(r.booking_id::text, 8));

    insert into public.notifications (user_id, title, message, notification_type, action_url, is_read, booking_id)
    select r.staff_id, 'You are off shift',
           'Booking #' || v_ref || ' has reached its time and you are not clocked in. Clock in to start it, or tell an administrator.',
           'OFF_SHIFT_PROMPT', '/staff/duty', false, r.booking_id
     where not exists (select 1 from public.notifications n where n.user_id = r.staff_id and n.booking_id = r.booking_id and n.notification_type = 'OFF_SHIFT_PROMPT');
    get diagnostics v_added = row_count;
    v_count := v_count + v_added;

    insert into public.notifications (user_id, title, message, notification_type, action_url, is_read, booking_id)
    select p.id, 'Technician off shift',
           r.staff_name || ' is assigned to booking #' || v_ref || ', which has reached its time, but is not clocked in. Reassign it or ask them to clock in.',
           'OFF_SHIFT_ASSIGNMENT', '/admin/bookings/' || r.booking_id, false, r.booking_id
      from public.profiles p
     where upper(coalesce(p.role, '')) = 'ADMIN' and coalesce(p.is_active, true)
       and not exists (select 1 from public.notifications n where n.user_id = p.id and n.booking_id = r.booking_id and n.notification_type = 'OFF_SHIFT_ASSIGNMENT');
  end loop;
  return v_count;
end;
$$;
revoke all on function public.alert_off_shift_assignments(timestamptz) from public, anon, authenticated;
grant execute on function public.alert_off_shift_assignments(timestamptz) to service_role;

-- 3. the sweep runs it
do $patch2$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.run_no_show_lifecycle'::regproc) into v_def;
  if v_def not like '%alert_off_shift_assignments%' then
    v_new := replace(v_def, 'v_reminded := public.remind_unstarted_services(now());', 'v_reminded := public.remind_unstarted_services(now()) + public.alert_off_shift_assignments(now());');
    if v_new = v_def then raise exception 'run_no_show_lifecycle layout changed; patch not applied'; end if;
    execute v_new;
  end if;
end
$patch2$;

-- 4. what the dashboard counts and the booking list filters on (administrators only)
create or replace function public.off_shift_assignments()
returns table (booking_id uuid, staff_id uuid, staff_name text, start_datetime timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  return query
  select distinct b.id, t.staff_id, coalesce(nullif(trim(p.full_name), ''), p.email, 'Technician'), b.start_datetime
    from public.bookings b
    join lateral (
      select b.staff_id as staff_id where b.staff_id is not null
      union
      select bv.staff_id from public.booking_vehicles bv where bv.booking_id = b.id and bv.staff_id is not null
    ) t on true
    join public.profiles p on p.id = t.staff_id
   where lower(coalesce(b.status::text, '')) in ('confirmed', 'scheduled')
     and b.start_datetime <= now()
     and not coalesce(p.is_clocked_in, false)
   order by b.start_datetime;
end;
$$;
revoke all on function public.off_shift_assignments() from public, anon;
grant execute on function public.off_shift_assignments() to authenticated;
