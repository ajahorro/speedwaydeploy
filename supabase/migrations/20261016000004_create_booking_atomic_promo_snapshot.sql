-- ============================================================================
-- create_booking_atomic(): persist the promo/discount snapshot on the booking
-- ============================================================================
--
-- WHY
-- ---
-- The bookings table already has `applied_promo_id`, `promo_name_snapshot`, and
-- `discount_amount_snapshot` columns, but NOTHING ever wrote them:
--   * create_booking_atomic() ignores them in the INSERT, and
--   * the client's booking payload never sent them.
--
-- Consequence: an official receipt had no promo line (it read a
-- `selectedPayment.discount_amount` that does not exist), and analytics could
-- not attribute any discount to its promo. This migration teaches the RPC to
-- carry the snapshot the client now computes (via calculateBookingDiscountSummary)
-- so the ledger, receipt, and analytics all see the SAME frozen figures the
-- customer reviewed at creation time.
--
-- `discount_amount_snapshot` is numeric; the other two are text/uuid and are
-- nullable, so an unknown/omitted value simply stores NULL.
-- ============================================================================

create or replace function public.create_booking_atomic(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_id      uuid;
  v_booking         jsonb := coalesce(p_payload -> 'booking', '{}'::jsonb);
  v_vehicles        jsonb := coalesce(p_payload -> 'vehicles', '[]'::jsonb);
  v_payment         jsonb := p_payload -> 'payment';
  v_vehicle         jsonb;
  v_vehicle_json    jsonb;
  v_service         jsonb;
  v_services        jsonb;
  v_vehicle_id      uuid;
  v_vehicle_result  jsonb := '[]'::jsonb;
  v_vehicle_ids     jsonb := '[]'::jsonb;
  v_booking_row     jsonb;
  v_payment_row     jsonb;
  v_payment_status  booking_payment_status;
  v_payment_method  payment_method_type;
  v_payment_type    payment_type_enum;
  v_vehicle_type    vehicle_type;
begin
  -- Integrity shield (mirrors the client-side guard): never create a booking
  -- with no vehicles.
  if jsonb_typeof(v_vehicles) <> 'array' or jsonb_array_length(v_vehicles) = 0 then
    raise exception 'No vehicles provided for this booking session. Operation aborted for integrity.'
      using errcode = 'check_violation';
  end if;

  -- Resolve payment_status safely (text -> enum with a safe default).
  begin
    v_payment_status := coalesce(nullif(v_booking ->> 'payment_status', ''), 'unpaid')::booking_payment_status;
  exception when invalid_text_representation then
    v_payment_status := 'unpaid'::booking_payment_status;
  end;

  -- Resolve payment_method (text -> enum, normalised, nullable).
  begin
    v_payment_method := nullif(upper(replace(coalesce(v_booking ->> 'payment_method', ''), ' ', '_')), '')::payment_method_type;
  exception when invalid_text_representation then
    v_payment_method := null;
  end;

  -- Resolve the master booking's vehicle_type (display label -> enum member).
  v_vehicle_type := case lower(coalesce(v_booking ->> 'vehicle_type', ''))
    when 'sedan' then 'sedan'
    when 'suv' then 'suv'
    when 'van' then 'van'
    when 'van/l300' then 'van'
    when 'van / l300' then 'van'
    when 'pickup/van' then 'van'
    when 'pickup' then 'van'
    when 'regular' then 'motorcycle'
    when 'motorcycle' then 'motorcycle'
    when 'bigbike' then 'motorcycle'
    when 'big bike' then 'motorcycle'
    else null
  end;

  -- 1. Master booking row ----------------------------------------------------
  insert into public.bookings (
    customer_id, staff_id, resource_id, start_datetime, end_datetime, status,
    payment_status, payment_method, total_amount, estimated_duration_total,
    customer_phone, customer_notes, vehicle_type,
    contact_number, customer_name, customer_email, notes, ocr_metadata,
    active_qr_snapshot, qr_snapshot_version, service_snapshot,
    service_snapshot_version, is_walk_in, payment_type, bay_id,
    applied_promo_id, promo_name_snapshot, discount_amount_snapshot
  )
  select
    nullif(v_booking ->> 'customer_id', '')::uuid,
    nullif(v_booking ->> 'staff_id', '')::uuid,
    nullif(v_booking ->> 'resource_id', '')::uuid,
    (v_booking ->> 'start_datetime')::timestamptz,
    (v_booking ->> 'end_datetime')::timestamptz,
    coalesce(v_booking ->> 'status', 'scheduled'),
    v_payment_status,
    v_payment_method,
    coalesce((v_booking ->> 'total_amount')::numeric, 0),
    coalesce((v_booking ->> 'estimated_duration_total')::integer, 0),
    v_booking ->> 'customer_phone',
    v_booking ->> 'customer_notes',
    v_vehicle_type,
    v_booking ->> 'contact_number',
    v_booking ->> 'customer_name',
    v_booking ->> 'customer_email',
    v_booking ->> 'notes',
    coalesce(v_booking -> 'ocr_metadata', '{}'::jsonb),
    v_booking -> 'active_qr_snapshot',
    nullif(v_booking ->> 'qr_snapshot_version', '')::integer,
    coalesce(v_booking -> 'service_snapshot', '[]'::jsonb),
    coalesce((v_booking ->> 'service_snapshot_version')::integer, 1),
    coalesce((v_booking ->> 'is_walk_in')::boolean, false),
    v_booking ->> 'payment_type',
    nullif(v_booking ->> 'bay_id', '')::uuid,
    nullif(v_booking ->> 'applied_promo_id', '')::uuid,
    nullif(v_booking ->> 'promo_name_snapshot', ''),
    coalesce((v_booking ->> 'discount_amount_snapshot')::numeric, 0)
  returning id into v_booking_id;

  -- 2. Vehicles + their services --------------------------------------------
  for v_vehicle in select * from jsonb_array_elements(v_vehicles)
  loop
    v_vehicle_json := coalesce(v_vehicle -> 'vehicle', '{}'::jsonb);
    v_services := coalesce(v_vehicle -> 'services', '[]'::jsonb);

    insert into public.booking_vehicles (
      booking_id, vehicle_type, brand, model, plate_number, status,
      fleet_group_id, subtotal, service_notes
    )
    values (
      v_booking_id,
      v_vehicle_json ->> 'vehicle_type',
      v_vehicle_json ->> 'brand',
      v_vehicle_json ->> 'model',
      v_vehicle_json ->> 'plate_number',
      coalesce(v_vehicle_json ->> 'status', 'SCHEDULED'),
      nullif(v_vehicle_json ->> 'fleet_group_id', '')::uuid,
      coalesce((v_vehicle_json ->> 'subtotal')::numeric, 0),
      v_vehicle_json ->> 'service_notes'
    )
    returning id into v_vehicle_id;

    v_vehicle_ids := v_vehicle_ids || to_jsonb(v_vehicle_id);

    if jsonb_typeof(v_services) = 'array' and jsonb_array_length(v_services) > 0 then
      for v_service in select * from jsonb_array_elements(v_services)
      loop
        insert into public.booking_vehicle_services (
          booking_vehicle_id, service_name, price, final_price, base_price,
          price_at_booking, duration_snapshot, vehicle_type, service_id,
          service_snapshot, service_version, service_name_snapshot, price_snapshot, step_order
        )
        values (
          v_vehicle_id,
          v_service ->> 'service_name',
          coalesce((v_service ->> 'price')::numeric, 0),
          coalesce((v_service ->> 'final_price')::numeric, 0),
          coalesce((v_service ->> 'base_price')::numeric, 0),
          coalesce((v_service ->> 'price_at_booking')::numeric, 0),
          nullif(v_service ->> 'duration_minutes', '')::integer,
          v_service ->> 'vehicle_type',
          case
            when nullif(v_service ->> 'service_id', '') is null then null
            when nullif(v_service ->> 'service_id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              then (nullif(v_service ->> 'service_id', ''))::uuid
            else null
          end,
          v_service -> 'service_snapshot',
          coalesce((v_service ->> 'service_version')::integer, 1),
          v_service ->> 'service_name',
          coalesce((v_service ->> 'final_price')::numeric, 0),
          coalesce((v_service ->> 'step_order')::integer, 0)
        );
      end loop;
    end if;

    v_vehicle_result := v_vehicle_result || to_jsonb(v_vehicle_id);
  end loop;

  -- 3. Payment (optional) ----------------------------------------------------
  if v_payment is not null and jsonb_typeof(v_payment) = 'object' then
    begin
      v_payment_type := nullif(initcap(coalesce(v_payment ->> 'payment_type', '')), '')::payment_type_enum;
    exception when invalid_text_representation then
      v_payment_type := null;
    end;

    insert into public.payments (
      booking_id, amount, method, payment_type, status, receipt_url,
      detected_amount, detected_ref, transfer_fee, net_credit, notes,
      reference_number, verified_by, verified_at
    )
    values (
      v_booking_id,
      coalesce((v_payment ->> 'amount')::numeric, 0),
      v_payment ->> 'method',
      v_payment_type,
      coalesce(v_payment ->> 'status', 'PENDING'),
      v_payment ->> 'receipt_url',
      nullif(v_payment ->> 'detected_amount', '')::numeric,
      v_payment ->> 'detected_ref',
      coalesce((v_payment ->> 'transfer_fee')::numeric, 0),
      nullif(v_payment ->> 'net_credit', '')::numeric,
      v_payment ->> 'notes',
      v_payment ->> 'reference_number',
      nullif(v_payment ->> 'verified_by', '')::uuid,
      nullif(v_payment ->> 'verified_at', '')::timestamptz
    )
    returning to_jsonb(payments.*) into v_payment_row;
  end if;

  select to_jsonb(b.*) into v_booking_row from public.bookings b where b.id = v_booking_id;

  return jsonb_build_object(
    'booking', v_booking_row,
    'vehicle_ids', v_vehicle_ids,
    'payment', v_payment_row
  );
end;
$$;

revoke all on function public.create_booking_atomic(jsonb) from public;
grant execute on function public.create_booking_atomic(jsonb) to authenticated;

comment on function public.create_booking_atomic(jsonb) is
  'Atomic booking creation. Writes the master booking (incl. the promo/discount snapshot), its vehicles, vehicle services, and the optional payment in a single transaction. Enum-typed columns are cast explicitly with safe fallbacks.';