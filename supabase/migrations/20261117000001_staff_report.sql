-- ============================================================================
-- Staff Reports: a technician's own work, with no money and no other technician's data.
-- Allowed only for an active STAFF account whose "can view reports" switch an administrator turned on.
--   schedule : this technician's vehicles for today and tomorrow (time, booking, vehicle, services, status)
--   counts   : this technician's jobs today, this week and this month, and all time
--   recent   : the last completed jobs
-- ============================================================================
create or replace function public.staff_report(p_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_tz text := public.shop_timezone();
  v_day date := coalesce(p_day, (now() at time zone public.shop_timezone())::date);
  v_week date := date_trunc('week', v_day::timestamp)::date;
  v_month date := date_trunc('month', v_day::timestamp)::date;
  v_schedule jsonb;
  v_counts jsonb;
  v_recent jsonb;
begin
  if v_uid is null or not exists (
    select 1 from public.profiles p
     where p.id = v_uid and upper(p.role) = 'STAFF' and coalesce(p.is_active, true) and coalesce(p.can_view_reports, false)
  ) then
    raise exception 'Reports are not enabled for this account.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_json order by start_at), '[]'::jsonb)
    into v_schedule
    from (
      select b.start_datetime as start_at,
             jsonb_build_object(
               'day', (b.start_datetime at time zone v_tz)::date,
               'start', b.start_datetime,
               'end', b.end_datetime,
               'booking', upper(left(b.id::text, 8)),
               'customer', b.customer_name,
               'vehicle', nullif(btrim(concat_ws(' ', v.brand, v.model)), ''),
               'plate', v.plate_number,
               'status', v.status,
               'services', coalesce((select jsonb_agg(s.service_name order by s.service_name)
                                       from public.booking_vehicle_services s where s.booking_vehicle_id = v.id), '[]'::jsonb)
             ) as row_json
        from public.booking_vehicles v
        join public.bookings b on b.id = v.booking_id
       where v.staff_id = v_uid
         and lower(coalesce(b.status, '')) not in ('cancelled', 'flagged_noshow', 'no_show')
         and (b.start_datetime at time zone v_tz)::date between v_day and v_day + 1
    ) q;

  select jsonb_build_object(
      'today_total', count(*) filter (where d = v_day and not cancelled),
      'today_completed', count(*) filter (where d = v_day and done),
      'today_in_progress', count(*) filter (where d = v_day and active),
      'today_pending', count(*) filter (where d = v_day and not cancelled and not done and not active),
      'week_completed', count(*) filter (where done and d >= v_week and d <= v_day),
      'month_completed', count(*) filter (where done and d >= v_month and d <= v_day),
      'all_completed', count(*) filter (where done)
    )
    into v_counts
    from (
      select (b.start_datetime at time zone v_tz)::date as d,
             upper(coalesce(v.status, '')) in ('COMPLETED', 'RELEASED') as done,
             upper(coalesce(v.status, '')) in ('IN_PROGRESS', 'ONGOING') as active,
             upper(coalesce(v.status, '')) = 'CANCELLED' or lower(coalesce(b.status, '')) in ('cancelled', 'flagged_noshow', 'no_show') as cancelled
        from public.booking_vehicles v
        join public.bookings b on b.id = v.booking_id
       where v.staff_id = v_uid
    ) t;

  select coalesce(jsonb_agg(row_json order by finished desc), '[]'::jsonb)
    into v_recent
    from (
      select coalesce(v.completed_at, b.updated_at) as finished,
             jsonb_build_object(
               'finished', coalesce(v.completed_at, b.updated_at),
               'booking', upper(left(b.id::text, 8)),
               'vehicle', nullif(btrim(concat_ws(' ', v.brand, v.model)), ''),
               'plate', v.plate_number,
               'services', coalesce((select jsonb_agg(s.service_name order by s.service_name)
                                       from public.booking_vehicle_services s where s.booking_vehicle_id = v.id), '[]'::jsonb)
             ) as row_json
        from public.booking_vehicles v
        join public.bookings b on b.id = v.booking_id
       where v.staff_id = v_uid and upper(coalesce(v.status, '')) in ('COMPLETED', 'RELEASED')
       order by coalesce(v.completed_at, b.updated_at) desc
       limit 10
    ) r;

  return jsonb_build_object('day', v_day, 'tomorrow', v_day + 1, 'schedule', v_schedule, 'counts', v_counts, 'recent', v_recent);
end;
$fn$;

revoke all on function public.staff_report(date) from public, anon;
grant execute on function public.staff_report(date) to authenticated;
