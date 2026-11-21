-- A shift that crosses midnight (clock in 11:34 PM, clock out 7:47 AM the next day) was only ever attributed to the
-- clock-in day: the clock-out day got no entry, no calendar dot, and nothing to show. Expand each attendance row
-- across every Manila calendar day it actually spans (clock-in day through clock-out day, or today while still on
-- shift) so the session shows up — with its real timestamps — on every day it touches. Capped at 31 days so a
-- forgotten clock-out can't blow up the expansion.

create or replace function public.staff_work_history_range(p_staff uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_staff is distinct from auth.uid() and not public.is_admin() then
    raise exception 'You can only view your own history.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a range of up to 62 days.' using errcode = '22023';
  end if;

  with att as (
    select a.id, a.clock_in_at, a.clock_out_at, gs.day
      from public.staff_attendance a
      cross join lateral generate_series(
             (a.clock_in_at at time zone 'Asia/Manila')::date,
             least(
               coalesce((a.clock_out_at at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date),
               (a.clock_in_at at time zone 'Asia/Manila')::date + 31
             ),
             interval '1 day'
           ) as gs(day)
     where a.staff_id = p_staff
  ),
  veh as (
    select bv.id, b.id as booking_id, (b.start_datetime at time zone 'Asia/Manila')::date as day,
           coalesce(bv.brand, bv.make) as brand, bv.model, bv.plate_number, bv.vehicle_type, bv.status,
           bv.started_at, bv.completed_at, bv.service_notes, b.start_datetime, b.customer_name,
           coalesce((select jsonb_agg(s.service_name order by s.step_order, s.created_at)
                       from public.booking_vehicle_services s where s.booking_vehicle_id = bv.id), '[]'::jsonb) as services
      from public.booking_vehicles bv
      join public.bookings b on b.id = bv.booking_id
     where bv.staff_id = p_staff
       and coalesce(bv.is_cancelled, false) = false
       and lower(coalesce(b.status::text, '')) <> 'cancelled'
  ),
  shown as (
    select day from (select day from att union select day from veh) d where day between p_from and p_to
  )
  select jsonb_build_object(
           'days', coalesce((
             select jsonb_agg(jsonb_build_object(
               'day', s.day,
               'sessions', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'clock_in_at', a.clock_in_at, 'clock_out_at', a.clock_out_at) order by a.clock_in_at)
                                       from att a where a.day = s.day), '[]'::jsonb),
               'vehicles', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', v.id, 'booking_id', v.booking_id, 'brand', v.brand, 'model', v.model,
                                'plate_number', v.plate_number, 'vehicle_type', v.vehicle_type, 'status', v.status,
                                'started_at', v.started_at, 'completed_at', v.completed_at, 'service_notes', v.service_notes,
                                'start_datetime', v.start_datetime, 'customer_name', v.customer_name, 'services', v.services)
                                order by v.start_datetime)
                                from veh v where v.day = s.day), '[]'::jsonb)
             ) order by s.day desc)
             from shown s), '[]'::jsonb)
         )
    into v_result;
  return v_result;
end;
$$;

create or replace function public.staff_work_history(p_staff uuid, p_before date default null, p_days integer default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 3), 31));
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_staff is distinct from auth.uid() and not public.is_admin() then
    raise exception 'You can only view your own history.' using errcode = '42501';
  end if;

  with att as (
    select a.id, a.clock_in_at, a.clock_out_at, gs.day
      from public.staff_attendance a
      cross join lateral generate_series(
             (a.clock_in_at at time zone 'Asia/Manila')::date,
             least(
               coalesce((a.clock_out_at at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date),
               (a.clock_in_at at time zone 'Asia/Manila')::date + 31
             ),
             interval '1 day'
           ) as gs(day)
     where a.staff_id = p_staff
  ),
  veh as (
    select bv.id, b.id as booking_id, (b.start_datetime at time zone 'Asia/Manila')::date as day,
           coalesce(bv.brand, bv.make) as brand, bv.model, bv.plate_number, bv.vehicle_type, bv.status,
           bv.started_at, bv.completed_at, bv.service_notes, b.start_datetime, b.customer_name,
           coalesce((select jsonb_agg(s.service_name order by s.step_order, s.created_at)
                       from public.booking_vehicle_services s where s.booking_vehicle_id = bv.id), '[]'::jsonb) as services
      from public.booking_vehicles bv
      join public.bookings b on b.id = bv.booking_id
     where bv.staff_id = p_staff
       and coalesce(bv.is_cancelled, false) = false
       and lower(coalesce(b.status::text, '')) <> 'cancelled'
  ),
  all_days as (
    select day from att union select day from veh
  ),
  picked as (
    select day from all_days
     where p_before is null or day < p_before
     order by day desc
     limit v_days + 1
  ),
  shown as (
    select day from picked order by day desc limit v_days
  )
  select jsonb_build_object(
           'days', coalesce((
             select jsonb_agg(jsonb_build_object(
               'day', s.day,
               'sessions', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'clock_in_at', a.clock_in_at, 'clock_out_at', a.clock_out_at) order by a.clock_in_at)
                                       from att a where a.day = s.day), '[]'::jsonb),
               'vehicles', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', v.id, 'booking_id', v.booking_id, 'brand', v.brand, 'model', v.model,
                                'plate_number', v.plate_number, 'vehicle_type', v.vehicle_type, 'status', v.status,
                                'started_at', v.started_at, 'completed_at', v.completed_at, 'service_notes', v.service_notes,
                                'start_datetime', v.start_datetime, 'customer_name', v.customer_name, 'services', v.services)
                                order by v.start_datetime)
                                from veh v where v.day = s.day), '[]'::jsonb)
             ) order by s.day desc)
             from shown s), '[]'::jsonb),
           'has_more', (select count(*) from picked) > v_days
         )
    into v_result;
  return v_result;
end;
$$;
