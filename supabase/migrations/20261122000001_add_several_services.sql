-- ============================================================================
-- Add several services to a booking at once.
--   * apply_added_services() adds a list of services (each for its vehicle) in ONE step: every service line,
--     the single payment for their combined price, the new total and finish time. If anything fails, nothing
--     is added. It reuses apply_added_service() for each line, so every existing rule still applies.
--   * The people affected get ONE notice that names all the services, not one notice per service; the
--     technician of each affected vehicle is told about the services on that vehicle.
--   * The payment is judged against the booking total including every added service.
-- apply_added_service() (one service) is unchanged and still works.
-- ============================================================================

-- The notice: quiet while a batch is being applied (the batch sends its own notices at the end), and worded
-- for one or several services.
create or replace function public.notify_service_added(
  p_booking_id uuid,
  p_service_name text,
  p_actor_role text,
  p_vehicle_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_booking public.bookings%rowtype;
  v_ref text;
  v_staff uuid;
  v_many boolean := position('", "' in p_service_name) > 0;
  v_verb text := case when position('", "' in p_service_name) > 0 then ' were ' else ' was ' end;
begin
  if coalesce(current_setting('comar.batch_service_notice', true), '') = '1' then return; end if;
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then return; end if;
  v_ref := left(p_booking_id::text, 8);
  v_staff := case when p_vehicle_id is not null then public.vehicle_technician(p_vehicle_id) else v_booking.staff_id end;

  if upper(coalesce(p_actor_role, '')) = 'CUSTOMER' then
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    select p.id, case when v_many then 'Services Added by Customer' else 'Service Added by Customer' end,
           'The customer added "' || p_service_name || '" to booking #' || v_ref || '.',
           'SERVICE_ADDED', '/admin/bookings/' || p_booking_id, p_booking_id, p_booking_id, false
      from public.profiles p
     where upper(p.role) = 'ADMIN' and coalesce(p.is_active, true);
  elsif v_booking.customer_id is not null then
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    values (v_booking.customer_id, case when v_many then 'Services Added' else 'Service Added' end,
            '"' || p_service_name || '"' || v_verb || 'added to your booking #' || v_ref || '. Your total and finish time were updated.',
            'SERVICE_ADDED', '/customer/bookings/' || p_booking_id, p_booking_id, p_booking_id, false);
  end if;

  if v_staff is not null then
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    values (v_staff, 'Job Updated',
            '"' || p_service_name || '"' || v_verb || 'added to booking #' || v_ref || '. Check the job for the new work and finish time.',
            'JOB_UPDATED', '/staff/tasks', p_booking_id, p_booking_id, false);
  end if;
end;
$fn$;
revoke all on function public.notify_service_added(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.notify_service_added(uuid, text, text, uuid) to service_role;

create or replace function public.apply_added_services(
  p_booking_id uuid,
  p_items jsonb,
  p_payment jsonb,
  p_scan_id uuid,
  p_actor_id uuid,
  p_actor_name text,
  p_actor_role text,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_item jsonb;
  v_first boolean := true;
  v_payment_id uuid;
  v_line_payment_id uuid;
  v_names text[] := '{}';
  v_added numeric := 0;
  v_old_total numeric;
  v_lead uuid;
  v_ref text := left(p_booking_id::text, 8);
  v_vehicle record;
  v_tech uuid;
  v_vehicle_names text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one service is required.' using errcode = '22023';
  end if;

  select coalesce(total_amount, 0), staff_id into v_old_total, v_lead from public.bookings where id = p_booking_id;
  perform set_config('comar.batch_service_notice', '1', true);

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_line_payment_id := public.apply_added_service(
      p_booking_id,
      (v_item ->> 'vehicle_id')::uuid,
      v_item ->> 'service_name',
      (v_item ->> 'price')::numeric,
      coalesce(nullif(v_item ->> 'duration', '')::integer, 60),
      v_item ->> 'vehicle_type',
      case when v_first then p_payment else null end,
      case when v_first then p_scan_id else null end,
      p_actor_id, p_actor_name, p_actor_role, p_note
    );
    if v_first then v_payment_id := v_line_payment_id; end if;
    v_first := false;
    v_names := v_names || (v_item ->> 'service_name');
    v_added := v_added + (v_item ->> 'price')::numeric;
  end loop;

  perform set_config('comar.batch_service_notice', '', true);

  -- the one payment is judged against the booking total with every added service in it
  if v_payment_id is not null and p_scan_id is not null then
    update public.payments set ocr_evaluated_total = v_old_total + v_added where id = v_payment_id;
  end if;

  -- one notice for the customer or the administrators, naming every service (and the lead technician)
  perform public.notify_service_added(p_booking_id, array_to_string(v_names, '", "'), p_actor_role, null);

  -- the technician of each other affected vehicle hears about the services on THEIR vehicle
  for v_vehicle in
    select distinct (i ->> 'vehicle_id')::uuid as vehicle_id from jsonb_array_elements(p_items) i
  loop
    v_tech := public.vehicle_technician(v_vehicle.vehicle_id);
    continue when v_tech is null or v_tech is not distinct from v_lead;
    select string_agg(i ->> 'service_name', '", "' order by i ->> 'service_name') into v_vehicle_names
      from jsonb_array_elements(p_items) i where (i ->> 'vehicle_id')::uuid = v_vehicle.vehicle_id;
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    values (v_tech, 'Job Updated',
            '"' || v_vehicle_names || '"' || case when position('", "' in v_vehicle_names) > 0 then ' were ' else ' was ' end
              || 'added to booking #' || v_ref || '. Check the job for the new work and finish time.',
            'JOB_UPDATED', '/staff/tasks', p_booking_id, p_booking_id, false);
  end loop;

  return v_payment_id;
end;
$fn$;
revoke all on function public.apply_added_services(uuid, jsonb, jsonb, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_added_services(uuid, jsonb, jsonb, uuid, uuid, text, text, text) to service_role;
