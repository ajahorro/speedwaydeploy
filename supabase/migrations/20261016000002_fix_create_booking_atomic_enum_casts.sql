-- ============================================================================
-- Fix create_booking_atomic(): cast JSON text -> the real enum column types
-- ============================================================================
--
-- DEFECT (three instances of the SAME class of bug)
-- -------------------------------------------------
-- The original create_booking_atomic() (20261001000001) inserts enum-typed
-- columns straight from `->>`, which returns JSON as TEXT:
--
--     coalesce(v_booking ->> 'payment_status', 'unpaid'),   -- bookings.payment_status
--     v_booking ->> 'payment_method',                        -- bookings.payment_method
--     v_payment ->> 'payment_type',                          -- payments.payment_type
--
-- PostgreSQL does not implicitly cast text -> enum in an INSERT column list, so
-- every booking that reached the RPC aborted with, in order:
--
--     column "payment_status" is of type booking_payment_status
--       but expression is of type text
--     column "payment_method" is of type payment_method_type
--       but expression is of type text
--     column "payment_type" is of type payment_type_enum
--       but expression is of type text
--
-- This is the reported "atomic booking type crash".
--
-- FIX
-- ---
-- Resolve each value into a strictly-typed local variable, normalising the
-- client's display casing and falling back safely on an unexpected value (so a
-- bad value can never abort the whole booking transaction):
--   * payment_status : '' -> 'unpaid'; unknown -> 'unpaid'  (booking_payment_status)
--   * payment_method : 'Gcash'/'Cash' -> GCASH/CASH; space -> '_'; unknown -> NULL
--   * payment_type   : 'full' -> 'Full'; unknown -> NULL    (payment_type_enum)
--
-- `status` (bookings.status) is a plain TEXT column, so it needs no cast — it is
-- left exactly as-is. The rest of the function body is preserved verbatim so this
-- migration is a surgical, value-preserving replacement.
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
begin
  -- Integrity shield (mirrors the client-side guard): never create a booking
  -- with no vehicles.
  if jsonb_typeof(v_vehicles) <> 'array' or jsonb_array_length(v_vehicles) = 0 then
    raise exception 'No vehicles provided for this booking session. Operation aborted for integrity.'
      using errcode = 'check_violation';
  end if;

  -- Resolve payment_status safely. The client normally omits it (the RPC then
  -- defaults to 'unpaid'), but an older client may still send a value. Casting
  -- text -> enum directly would raise 22P02 on anything unexpected, so we first
  -- validate the payload against the enum and fall back to 'unpaid'.
  begin
    v_payment_status := coalesce(nullif(v_booking ->> 'payment_status', ''), 'unpaid')::booking_payment_status;
  exception when invalid_text_representation then
    v_payment_status := 'unpaid'::booking_payment_status;
  end;

  -- Resolve payment_method the same way. bookings.payment_method is the enum
  -- `payment_method_type` (GCASH | CASH | BANK_TRANSFER). Clients send display
  -- values like 'GCash'/'Cash', so normalise to upper-case snake before casting
  -- and fall back to NULL (the column is nullable) on anything unrecognised —
  -- a bad method must never abort the whole booking transaction.
  begin
    v_payment_method := nullif(upper(replace(coalesce(v_booking ->> 'payment_method', ''), ' ', '_')), '')::payment_method_type;
  exception when invalid_text_representation then
    v_payment_method := null;
  end;

  -- 1. Master booking row ----------------------------------------------------
  insert into public.bookings (
    customer_id, staff_id, resource_id, start_datetime, end_datetime, status,
    payment_status, payment_method, total_amount, estimated_duration_total,
    customer_phone, customer_notes, vehicle_type,
    contact_number, customer_name, customer_email, notes, ocr_metadata,
    active_qr_snapshot, qr_snapshot_version, service_snapshot,
    service_snapshot_version, is_walk_in, payment_type, bay_id
  )
  select
    nullif(v_booking ->> 'customer_id', '')::uuid,
    nullif(v_booking ->> 'staff_id', '')::uuid,
    nullif(v_booking ->> 'resource_id', '')::uuid,
    (v_booking ->> 'start_datetime')::timestamptz,
    (v_booking ->> 'end_datetime')::timestamptz,
    coalesce(v_booking ->> 'status', 'scheduled'),
    v_payment_status,                                    -- strictly typed enum
    v_payment_method,                                    -- strictly typed enum (or null)
    coalesce((v_booking ->> 'total_amount')::numeric, 0),
    coalesce((v_booking ->> 'estimated_duration_total')::integer, 0),
    v_booking ->> 'customer_phone',
    v_booking ->> 'customer_notes',
    v_booking ->> 'vehicle_type',
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
    nullif(v_booking ->> 'bay_id', '')::uuid
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
    -- payments.payment_type is the enum `payment_type_enum` (Full | Downpayment).
    -- Normalise the client's casing and fall back to NULL rather than aborting
    -- the whole atomic booking on an unexpected value.
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
      v_payment_type,                                      -- strictly typed enum (or null)
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
  'Atomic booking creation. Writes the master booking, its vehicles, vehicle services, and the optional payment in a single transaction. payment_status is cast to the booking_payment_status enum with a safe ''unpaid'' fallback so an unexpected client value cannot abort the insert.';