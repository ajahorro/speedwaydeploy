-- ============================================================================
-- Adding a service to a booking, with its payment, in one safe step.
--
--   * catalog_builtin_services gets the service duration, so the SERVER decides how much longer a
--     booking becomes (a browser can no longer claim a short duration to dodge the schedule check);
--   * catalog_service_duration(name) returns that duration (built-in or custom service);
--   * apply_added_service(...) (backend only) locks the booking, adds the service, records the
--     payment (already verified for an admin, awaiting verification for a customer), consumes the
--     receipt scan, extends the booking end time and total, and writes the audit entry, all together.
-- ============================================================================
alter table public.catalog_builtin_services add column if not exists duration_minutes integer;

update public.catalog_builtin_services as c set duration_minutes = v.minutes
from (values
  ('pkg_1', 240),
  ('pkg_2', 300),
  ('wash_1', 60),
  ('wash_2', 120),
  ('ext_1', 90),
  ('ext_2', 120),
  ('ext_3', 180),
  ('ext_4', 60),
  ('ext_5', 90),
  ('ext_6', 120),
  ('ext_7', 150),
  ('ext_8', 120),
  ('int_1', 270),
  ('int_2', 30),
  ('int_3', 120),
  ('int_4', 120),
  ('det_1', 2880),
  ('det_2', 1440),
  ('det_3', 240),
  ('det_4', 180),
  ('moto_1', 30),
  ('moto_2', 60),
  ('moto_3', 240),
  ('moto_4', 1440),
  ('moto_5', 300),
  ('add_1', 30),
  ('add_2', 30),
  ('add_3', 30)
) as v(service_id, minutes)
where c.service_id = v.service_id;

update public.catalog_builtin_services set duration_minutes = 60 where duration_minutes is null;

create or replace function public.catalog_service_duration(p_name text)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_name text := lower(btrim(coalesce(p_name, '')));
  v_custom jsonb;
  e jsonb;
  v_minutes integer;
begin
  if v_name = '' then return null; end if;
  select coalesce(custom_services, '[]'::jsonb) into v_custom from public.business_config order by id limit 1;
  if jsonb_typeof(v_custom) = 'array' then
    for e in select * from jsonb_array_elements(v_custom) loop
      continue when lower(btrim(coalesce(e ->> 'name', ''))) <> v_name;
      begin
        v_minutes := coalesce(nullif(e ->> 'durationMinutes', ''), nullif(e ->> 'duration_minutes', ''))::numeric::integer;
      exception when others then v_minutes := null; end;
      return greatest(1, coalesce(v_minutes, 60));
    end loop;
  end if;
  select max(duration_minutes) into v_minutes from public.catalog_builtin_services where lower(name) = v_name;
  return v_minutes;
end;
$$;
revoke all on function public.catalog_service_duration(text) from public, anon, authenticated;
grant execute on function public.catalog_service_duration(text) to service_role;

create or replace function public.apply_added_service(
  p_booking_id uuid,
  p_vehicle_id uuid,
  p_service_name text,
  p_price numeric,
  p_duration integer,
  p_vehicle_type text,
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
  v_booking public.bookings%rowtype;
  v_payment_id uuid;
  v_now timestamptz := now();
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking not found' using errcode = 'no_data_found';
  end if;
  if public.booking_is_terminal(v_booking.status) then
    raise exception 'This booking is closed (status: %) and can no longer be modified.', v_booking.status using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.booking_vehicles where id = p_vehicle_id and booking_id = p_booking_id) then
    raise exception 'Vehicle does not belong to this booking' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.booking_vehicle_services where booking_vehicle_id = p_vehicle_id and lower(service_name) = lower(p_service_name)) then
    raise exception 'This service is already assigned to the vehicle.' using errcode = 'check_violation';
  end if;

  insert into public.booking_vehicle_services (booking_vehicle_id, service_name, price, duration_minutes, vehicle_type, service_snapshot)
  values (p_vehicle_id, p_service_name, p_price, p_duration, p_vehicle_type,
          jsonb_build_object('name', p_service_name, 'price', p_price, 'duration_minutes', p_duration, 'source', 'added_service'));

  if p_payment is not null and jsonb_typeof(p_payment) = 'object' then
    insert into public.payments (
      booking_id, amount, method, payment_type, status, reference_number, receipt_url,
      detected_ref, detected_amount, transfer_fee, net_credit,
      verified_by, verified_at, ocr_evaluated_total, ocr_evaluated_at, notes
    ) values (
      p_booking_id,
      (p_payment ->> 'amount')::numeric,
      coalesce(p_payment ->> 'method', 'GCash'),
      coalesce(nullif(p_payment ->> 'payment_type', ''), 'Manual')::public.payment_type_enum,
      coalesce(p_payment ->> 'status', 'PAID'),
      nullif(p_payment ->> 'reference_number', ''),
      nullif(p_payment ->> 'receipt_url', ''),
      nullif(p_payment ->> 'detected_ref', ''),
      nullif(p_payment ->> 'detected_amount', '')::numeric,
      coalesce(nullif(p_payment ->> 'transfer_fee', '')::numeric, 0),
      nullif(p_payment ->> 'net_credit', '')::numeric,
      nullif(p_payment ->> 'verified_by', '')::uuid,
      nullif(p_payment ->> 'verified_at', '')::timestamptz,
      case when p_scan_id is not null then v_booking.total_amount + p_price end,
      case when p_scan_id is not null then v_now end,
      p_payment ->> 'notes'
    ) returning id into v_payment_id;
  end if;

  if p_scan_id is not null then
    update public.ocr_scan_sessions set active = false, booking_id = p_booking_id, payment_id = v_payment_id where id = p_scan_id;
  end if;

  update public.bookings
     set total_amount = coalesce(total_amount, 0) + p_price,
         end_datetime = coalesce(end_datetime, start_datetime, v_now) + make_interval(mins => coalesce(p_duration, 0)),
         updated_at = v_now
   where id = p_booking_id;

  insert into public.audit_logs (booking_id, action_type, details, actor_name, actor_role, actor_id, metadata)
  values (p_booking_id, 'BOOKING_UPDATED', coalesce(p_note, 'Service added: ' || p_service_name),
          coalesce(p_actor_name, 'System'), coalesce(p_actor_role, 'SYSTEM'), p_actor_id,
          jsonb_build_object('service_name', p_service_name, 'total_delta', p_price, 'duration_added', p_duration, 'payment_id', v_payment_id));

  return v_payment_id;
exception
  when unique_violation then
    raise exception 'That payment reference has already been used on another payment.' using errcode = '23505';
end;
$fn$;
revoke all on function public.apply_added_service(uuid, uuid, text, numeric, integer, text, jsonb, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_added_service(uuid, uuid, text, numeric, integer, text, jsonb, uuid, uuid, text, text, text) to service_role;
