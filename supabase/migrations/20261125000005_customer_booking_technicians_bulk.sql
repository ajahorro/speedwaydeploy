-- The customer's dashboard card showed "Unassigned": it read the lead technician from a direct profile read, which a
-- customer is not allowed. The technician of every vehicle, for several of the customer's own bookings at once.
create or replace function public.get_customer_bookings_technicians(p_booking_ids uuid[])
returns table (booking_id uuid, vehicle_id uuid, technician_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  return query
    select bv.booking_id, bv.id,
           coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(concat_ws(' ', pr.first_name, pr.last_name)), ''))
      from public.booking_vehicles bv
      join public.bookings b on b.id = bv.booking_id
      left join public.profiles pr on pr.id = bv.staff_id
     where bv.booking_id = any(p_booking_ids)
       and (b.customer_id = auth.uid() or public.is_admin())
     order by bv.created_at, bv.id;
end;
$$;
revoke all on function public.get_customer_bookings_technicians(uuid[]) from public, anon;
grant execute on function public.get_customer_bookings_technicians(uuid[]) to authenticated;
