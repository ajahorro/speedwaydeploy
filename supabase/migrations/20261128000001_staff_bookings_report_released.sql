-- Treat released bookings as finished in staff report totals, matching admin
-- booking management and the technician vehicle-status counts.
create or replace function public.staff_bookings_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_tz text := public.shop_timezone();
  v_allowed boolean;
  v_rows jsonb;
  v_totals jsonb;
  v_services jsonb;
  v_days jsonb;
  v_techs jsonb;
  v_types jsonb;
begin
  select public.is_admin() or exists (
    select 1 from public.profiles p
     where p.id = v_uid and upper(p.role) = 'STAFF' and coalesce(p.is_active, true) and coalesce(p.can_view_reports, false)
  ) into v_allowed;
  if v_uid is null or not coalesce(v_allowed, false) then
    raise exception 'Reports are not enabled for this account.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'A valid date range is required' using errcode = '22023';
  end if;
  if p_to - p_from > interval '93 days' then
    raise exception 'The range is too long (maximum 93 days)' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row_json order by start_at), '[]'::jsonb)
    into v_rows
    from (
      select b.start_datetime as start_at,
             jsonb_build_object(
               'reference', upper(left(b.id::text, 8)),
               'start', b.start_datetime,
               'end', b.end_datetime,
               'status', b.status,
               'customer', b.customer_name,
               'walk_in', coalesce(b.is_walk_in, false),
               'vehicles', coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'brand', v.brand, 'model', v.model, 'plate', v.plate_number, 'type', v.vehicle_type, 'status', v.status,
                   'technician', nullif(btrim(coalesce(tp.full_name, '')), ''),
                   'services', coalesce((select jsonb_agg(s.service_name order by s.service_name)
                                           from public.booking_vehicle_services s where s.booking_vehicle_id = v.id), '[]'::jsonb)
                 ) order by v.plate_number)
                   from public.booking_vehicles v
                   left join public.profiles tp on tp.id = v.staff_id
                  where v.booking_id = b.id), '[]'::jsonb)
             ) as row_json
        from (select * from public.bookings where start_datetime >= p_from and start_datetime < p_to) b
       order by b.start_datetime
       limit 500
    ) q;

  select jsonb_build_object(
      'bookings', count(*),
      'vehicles', coalesce(sum((select count(*) from public.booking_vehicles v where v.booking_id = b.id)), 0),
      'upcoming', count(*) filter (where lower(coalesce(b.status, '')) in ('scheduled', 'confirmed', 'pending')),
      'in_progress', count(*) filter (where lower(coalesce(b.status, '')) = 'in_progress'),
      'completed', count(*) filter (where lower(coalesce(b.status, '')) in ('completed', 'released')),
      'cancelled', count(*) filter (where lower(coalesce(b.status, '')) in ('cancelled', 'flagged_noshow', 'no_show')),
      'walk_ins', count(*) filter (where coalesce(b.is_walk_in, false))
    )
    into v_totals
    from (select * from public.bookings where start_datetime >= p_from and start_datetime < p_to) b;

  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', n) order by n desc, name), '[]'::jsonb)
    into v_services
    from (
      select s.service_name as name, count(*) as n
        from public.booking_vehicle_services s
        join public.booking_vehicles v on v.id = s.booking_vehicle_id
        join (select * from public.bookings where start_datetime >= p_from and start_datetime < p_to) b on b.id = v.booking_id
       where lower(coalesce(b.status, '')) not in ('cancelled', 'flagged_noshow', 'no_show')
       group by s.service_name
       order by n desc, s.service_name
       limit 15
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'bookings', nb, 'vehicles', nv) order by d), '[]'::jsonb)
    into v_days
    from (
      select (b.start_datetime at time zone v_tz)::date as d,
             count(*) as nb,
             coalesce(sum((select count(*) from public.booking_vehicles v where v.booking_id = b.id)), 0) as nv
        from (select * from public.bookings where start_datetime >= p_from and start_datetime < p_to) b
       where lower(coalesce(b.status, '')) not in ('cancelled', 'flagged_noshow', 'no_show')
       group by 1
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'vehicles', nv, 'finished', nf) order by nv desc, name), '[]'::jsonb)
    into v_techs
    from (
      select coalesce(nullif(btrim(coalesce(tp.full_name, '')), ''), 'Not assigned') as name,
             count(*) as nv,
             count(*) filter (where upper(coalesce(v.status, '')) in ('COMPLETED', 'RELEASED')) as nf
        from public.booking_vehicles v
        join (select * from public.bookings where start_datetime >= p_from and start_datetime < p_to) b on b.id = v.booking_id
        left join public.profiles tp on tp.id = v.staff_id
       where lower(coalesce(b.status, '')) not in ('cancelled', 'flagged_noshow', 'no_show')
       group by 1
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object('type', ty, 'vehicles', n) order by n desc, ty), '[]'::jsonb)
    into v_types
    from (
      select coalesce(nullif(btrim(coalesce(v.vehicle_type, '')), ''), 'Other') as ty, count(*) as n
        from public.booking_vehicles v
        join (select * from public.bookings where start_datetime >= p_from and start_datetime < p_to) b on b.id = v.booking_id
       where lower(coalesce(b.status, '')) not in ('cancelled', 'flagged_noshow', 'no_show')
       group by 1
    ) x;

  return jsonb_build_object('from', p_from, 'to', p_to, 'totals', v_totals, 'bookings', v_rows,
                            'by_service', v_services, 'by_day', v_days, 'by_technician', v_techs, 'by_vehicle_type', v_types);
end;
$fn$;

revoke all on function public.staff_bookings_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.staff_bookings_report(timestamptz, timestamptz) to authenticated;
