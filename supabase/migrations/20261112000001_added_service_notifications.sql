-- ============================================================================
-- A service added to a booking now tells the people it affects.
--   * customer adds it  -> every active admin is told (a payment, if any, also raises its own
--                          "verification required" notice);
--   * admin/staff adds  -> the booking's customer is told;
--   * either way        -> the technician assigned to the booking is told that the job changed
--                          (more work, a later finish time).
-- Nothing else in apply_added_service changes.
-- ============================================================================
create or replace function public.notify_service_added(
  p_booking_id uuid,
  p_service_name text,
  p_actor_role text
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_booking public.bookings%rowtype;
  v_ref text;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then return; end if;
  v_ref := left(p_booking_id::text, 8);

  if upper(coalesce(p_actor_role, '')) = 'CUSTOMER' then
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    select p.id, 'Service Added by Customer',
           'The customer added "' || p_service_name || '" to booking #' || v_ref || '.',
           'SERVICE_ADDED', '/admin/bookings/' || p_booking_id, p_booking_id, p_booking_id, false
      from public.profiles p
     where upper(p.role) = 'ADMIN' and coalesce(p.is_active, true);
  elsif v_booking.customer_id is not null then
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    values (v_booking.customer_id, 'Service Added',
            '"' || p_service_name || '" was added to your booking #' || v_ref || '. Your total and finish time were updated.',
            'SERVICE_ADDED', '/customer/bookings/' || p_booking_id, p_booking_id, p_booking_id, false);
  end if;

  if v_booking.staff_id is not null then
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    values (v_booking.staff_id, 'Job Updated',
            '"' || p_service_name || '" was added to booking #' || v_ref || '. Check the job for the new work and finish time.',
            'JOB_UPDATED', '/staff/tasks', p_booking_id, p_booking_id, false);
  end if;
end;
$fn$;
revoke all on function public.notify_service_added(uuid, text, text) from public, anon, authenticated;
grant execute on function public.notify_service_added(uuid, text, text) to service_role;

-- apply_added_service calls it at the end (same body as before plus the one call).
do $$
declare
  v_def text := pg_get_functiondef('public.apply_added_service(uuid, uuid, text, numeric, integer, text, jsonb, uuid, uuid, text, text, text)'::regprocedure);
begin
  if v_def not like '%notify_service_added%' then
    v_def := replace(v_def, E'  return v_payment_id;\nexception', E'  perform public.notify_service_added(p_booking_id, p_service_name, p_actor_role);\n\n  return v_payment_id;\nexception');
    if v_def not like '%notify_service_added%' then
      raise exception 'could not patch apply_added_service';
    end if;
    execute v_def;
  end if;
end $$;
