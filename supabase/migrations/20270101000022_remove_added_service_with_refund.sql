-- Removing an individual service from a booking, with its paid amount automatically queued
-- in the Refund Hub — the mirror image of apply_added_service (20261111000001).
--
--   * Only while the booking is 'scheduled' or 'confirmed' — once work has started (in_progress/
--     ongoing) or the booking is completed/cancelled, removing a service makes no sense and is
--     refused.
--   * A vehicle must keep at least one service; removing its only service is refused (cancel the
--     vehicle/booking instead).
--   * Soft-removed (removed_at/removed_by stamped, row kept) rather than deleted, so the original
--     line item stays in the booking's history for audit purposes; every live read of a booking's
--     services filters removed_at is null.
--   * Lowers bookings.total_amount and end_datetime by the removed service's price/duration, then
--     reuses the existing excess-credit machinery (reconcile_booking_excess_credit, the same
--     function that powers "excess payment" refunds) so any amount already paid toward the now-
--     removed service surfaces as a queued refund in the Refund Hub — no separate refund RPC needed.
--   * Writes one audit_logs row for the removal, and a second if a refund was queued, plus a
--     customer notification.
alter table public.booking_vehicle_services add column if not exists removed_at timestamptz;
alter table public.booking_vehicle_services add column if not exists removed_by uuid references public.profiles(id);

-- apply_added_service's duplicate-service guard predates removed_at; without this fix a service
-- that was removed could never be re-added under the same name.
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
  if exists (select 1 from public.booking_vehicle_services where booking_vehicle_id = p_vehicle_id and lower(service_name) = lower(p_service_name) and removed_at is null) then
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

create or replace function public.remove_added_service(
  p_booking_id uuid,
  p_service_row_id uuid,
  p_actor_id uuid,
  p_actor_name text,
  p_actor_role text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_booking public.bookings%rowtype;
  v_vehicle_id uuid;
  v_service_name text;
  v_price numeric;
  v_duration integer;
  v_other_services integer;
  v_now timestamptz := now();
  v_new_total numeric;
  v_excess numeric := 0;
  v_balance numeric;
  v_ref text;
  v_refund_status text;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking not found' using errcode = 'no_data_found';
  end if;

  if lower(coalesce(v_booking.status, '')) not in ('scheduled', 'confirmed') then
    raise exception 'A service can only be removed while the booking is scheduled or confirmed (current status: %).', v_booking.status
      using errcode = 'check_violation';
  end if;

  select bvs.booking_vehicle_id,
         coalesce(bvs.service_name, bvs.service_name_snapshot),
         coalesce(nullif(bvs.price_at_booking, 0), nullif(bvs.final_price, 0), nullif(bvs.price_snapshot, 0), bvs.price, 0),
         coalesce(bvs.duration_minutes, bvs.duration_snapshot, 0)
    into v_vehicle_id, v_service_name, v_price, v_duration
    from public.booking_vehicle_services bvs
    join public.booking_vehicles bv on bv.id = bvs.booking_vehicle_id
   where bvs.id = p_service_row_id and bv.booking_id = p_booking_id and bvs.removed_at is null;

  if v_vehicle_id is null then
    raise exception 'That service was not found on this booking.' using errcode = 'no_data_found';
  end if;

  select count(*) into v_other_services
    from public.booking_vehicle_services
   where booking_vehicle_id = v_vehicle_id and id <> p_service_row_id and removed_at is null;
  if v_other_services = 0 then
    raise exception 'A vehicle must have at least one service. Remove the vehicle (or cancel the booking) instead.'
      using errcode = 'check_violation';
  end if;

  update public.booking_vehicle_services set removed_at = v_now, removed_by = p_actor_id where id = p_service_row_id;

  v_new_total := greatest(0, coalesce(v_booking.total_amount, 0) - v_price);
  update public.bookings
     set total_amount = v_new_total,
         end_datetime = greatest(
           coalesce(start_datetime, v_now),
           coalesce(end_datetime, start_datetime, v_now) - make_interval(mins => v_duration)
         ),
         updated_at = v_now
   where id = p_booking_id;

  insert into public.audit_logs (booking_id, action_type, details, actor_name, actor_role, actor_id, metadata)
  values (p_booking_id, 'SERVICE_REMOVED', coalesce(p_note, 'Service removed: ' || v_service_name),
          coalesce(p_actor_name, 'System'), coalesce(p_actor_role, 'SYSTEM'), p_actor_id,
          jsonb_build_object('service_name', v_service_name, 'total_delta', -v_price, 'duration_removed', v_duration, 'new_total', v_new_total));

  -- Re-sync the excess-credit ledger against the LOWER total; if the customer had already paid
  -- toward the removed service, that now shows up as excess and gets queued into the Refund Hub.
  perform public.reconcile_booking_excess_credit(p_booking_id);

  select upper(coalesce(refund_status, '')) into v_refund_status from public.bookings where id = p_booking_id;
  if v_refund_status not in ('QUEUED', 'PROCESSING', 'PROCESSED', 'EMAIL_PENDING') then
    v_excess := public.customer_booking_excess_credit(v_booking.customer_id, p_booking_id);
    if v_excess > 0 then
      perform pg_advisory_xact_lock(hashtext('speedway:credit:' || v_booking.customer_id::text));
      v_balance := greatest(0, public.customer_excess_credit(v_booking.customer_id) - v_excess);
      insert into public.customer_credit_ledger (customer_id, booking_id, entry_type, amount, balance_after, note)
      values (v_booking.customer_id, p_booking_id, 'REFUND_QUEUED', -v_excess, v_balance,
              'Amount already paid toward a removed service, queued for refund.');

      update public.bookings
         set refund_status = 'QUEUED', refund_notes = 'OVERPAYMENT_CREDIT:' || v_excess::text, updated_at = v_now
       where id = p_booking_id;

      v_ref := upper(left(p_booking_id::text, 8));
      insert into public.audit_logs (booking_id, action_type, details, actor_name, actor_role, actor_id, metadata)
      values (p_booking_id, 'OVERPAYMENT_REFUND_REQUESTED',
              'Removing "' || v_service_name || '" left ' || v_excess || ' already paid toward it; queued for refund.',
              coalesce(p_actor_name, 'System'), coalesce(p_actor_role, 'SYSTEM'), p_actor_id,
              jsonb_build_object('excess', v_excess, 'service_name', v_service_name));

      insert into public.notifications (user_id, title, message, notification_type, action_url, is_read, booking_id)
      select p.id, 'Excess refund requested',
             'Removing a service on booking #' || v_ref || ' left ₱' || v_excess || ' already paid toward it, now queued for refund.',
             'EXCESS_REFUND_REQUESTED', '/admin/refunds', false, p_booking_id
        from public.profiles p
       where upper(coalesce(p.role, '')) = 'ADMIN' and coalesce(p.is_active, true);
    end if;
  end if;

  insert into public.notifications (user_id, title, message, notification_type, action_url, is_read, booking_id)
  values (v_booking.customer_id, 'Service removed from your booking',
          '"' || v_service_name || '" was removed from booking #' || upper(left(p_booking_id::text, 8)) || '.'
            || case when v_excess > 0 then ' A refund of ₱' || v_excess || ' already paid toward it has been queued.' else '' end,
          'BOOKING_UPDATED', '/customer/bookings/' || p_booking_id::text, false, p_booking_id);

  return jsonb_build_object('removed_service', v_service_name, 'price_removed', v_price, 'new_total', v_new_total, 'refund_queued', v_excess);
end;
$fn$;

revoke all on function public.remove_added_service(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.remove_added_service(uuid, uuid, uuid, text, text, text) to service_role;
