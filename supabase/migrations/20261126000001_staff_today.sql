-- Accounts page, staff tab: who is working today. One call for the shop day (Manila): every technician who clocked
-- in that day with their clock-in and clock-out times, and the vehicles assigned to them that day. Administrators only.
create or replace function public.staff_today(p_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Asia/Manila')::date);
  v_result jsonb;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_json order by first_in), '[]'::jsonb)
    into v_result
    from (
      select min(a.clock_in_at) as first_in,
             jsonb_build_object(
               'id', p.id,
               'name', coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.email),
               'sessions', jsonb_agg(jsonb_build_object('clock_in_at', a.clock_in_at, 'clock_out_at', a.clock_out_at) order by a.clock_in_at),
               'on_duty', bool_or(a.clock_out_at is null),
               'vehicles', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', bv.id, 'booking_id', b.id, 'brand', coalesce(bv.brand, bv.make), 'model', bv.model,
                          'plate_number', bv.plate_number, 'status', bv.status, 'start_datetime', b.start_datetime,
                          'customer_name', b.customer_name,
                          'services', coalesce((select jsonb_agg(s.service_name order by s.step_order, s.created_at)
                                                  from public.booking_vehicle_services s where s.booking_vehicle_id = bv.id), '[]'::jsonb))
                        order by b.start_datetime)
                   from public.booking_vehicles bv
                   join public.bookings b on b.id = bv.booking_id
                  where bv.staff_id = p.id
                    and coalesce(bv.is_cancelled, false) = false
                    and lower(coalesce(b.status::text, '')) <> 'cancelled'
                    and (b.start_datetime at time zone 'Asia/Manila')::date = v_day), '[]'::jsonb)
             ) as row_json
        from public.staff_attendance a
        join public.profiles p on p.id = a.staff_id
       where (a.clock_in_at at time zone 'Asia/Manila')::date = v_day
       group by p.id, p.full_name, p.first_name, p.last_name, p.email
    ) q;

  return jsonb_build_object('day', v_day, 'staff', v_result);
end;
$fn$;
revoke all on function public.staff_today(date) from public, anon;
grant execute on function public.staff_today(date) to authenticated;
