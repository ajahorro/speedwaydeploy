create or replace function public.get_customer_booking_technician(p_booking_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean := false;
  v_technician_name text;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  select exists (
    select 1 from public.profiles
     where id = v_user_id
       and upper(coalesce(role, '')) = 'ADMIN'
  ) into v_is_admin;

  if not v_is_admin and not exists (
    select 1 from public.bookings
     where id = p_booking_id and customer_id = v_user_id
  ) then
    raise exception 'Booking access denied';
  end if;

  select coalesce(
    nullif(btrim(profile.full_name), ''),
    nullif(btrim(concat_ws(' ', profile.first_name, profile.last_name)), '')
  )
    into v_technician_name
    from public.bookings as booking
    join public.profiles as profile on profile.id = booking.staff_id
   where booking.id = p_booking_id;

  return v_technician_name;
end;
$$;

revoke all on function public.get_customer_booking_technician(uuid) from public, anon;
grant execute on function public.get_customer_booking_technician(uuid) to authenticated;