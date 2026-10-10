-- The technician's history as a calendar: every day of a date range (a month) at once, in the same shape as
-- staff_work_history (days with their clock-in/out sessions and vehicles). Technicians read their own, administrators
-- anyone's. At most 62 days per call. Who/when only: no money.

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
    select a.id, a.clock_in_at, a.clock_out_at, (a.clock_in_at at time zone 'Asia/Manila')::date as day
      from public.staff_attendance a
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

revoke all on function public.staff_work_history_range(uuid, date, date) from public, anon;
grant execute on function public.staff_work_history_range(uuid, date, date) to authenticated;
