-- Booking creation guards (found by a 22-scenario stress test).
-- 1. Capacity counted another customer's booking as 0 bays: the capacity check called the access-checked
--    public.booking_bay_usage(), which returns NULL for a booking the caller cannot read. Capacity code now uses
--    internal.booking_bay_usage() (all four functions are security definer).
-- 2. A multi-vehicle booking was checked as 1 bay (its vehicles are written after the booking row), so one booking
--    could fill a slot past capacity. The whole booking is checked again once its vehicles are in.
-- 3. Only an administrator books for someone else or creates a confirmed walk-in; staff accounts cannot book.
-- 4. A walk-in paid only in part (downpayment or a smaller amount) is stored as partially paid, not paid.
-- 5. A booking with no vehicles gets the "no vehicles" message instead of a price error.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosecdef
              and p.proname in ('enforce_slot_capacity', 'reschedule_booking', 'slot_has_capacity', 'slot_has_capacity_ignoring_hours')
              and p.prosrc like '%public.booking_bay_usage(%'
  loop
    execute replace(pg_get_functiondef(f), 'public.booking_bay_usage(', 'internal.booking_bay_usage(');
  end loop;
end $$;

create or replace function public.create_booking_atomic_secure(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_payment jsonb;
  v_scan_id uuid;
  v_scan public.ocr_scan_sessions%rowtype;
  v_method text;
  v_is_admin boolean := public.is_admin();
  v_is_admin_walk_in boolean;
  v_requires_scan boolean;
  v_verdict text;
  v_metadata jsonb;
  v_total_amount numeric;
  v_required_amount numeric;
  v_scanned_amount numeric;
  v_payment_type text;
  v_result jsonb;
  v_booking_id uuid;
  v_payment_id uuid;
begin
  if jsonb_typeof(v_payload -> 'vehicles') is distinct from 'array' or jsonb_array_length(v_payload -> 'vehicles') = 0 then
    raise exception 'No vehicles provided for this booking session. Operation aborted for integrity.' using errcode = '23514';
  end if;

  if not v_is_admin then
    if exists (select 1 from public.profiles where id = auth.uid() and upper(coalesce(role, '')) = 'STAFF') then
      raise exception 'Staff accounts cannot create bookings.' using errcode = '42501';
    end if;
    -- a customer books for their own account, as a scheduled booking awaiting the shop
    v_payload := jsonb_set(v_payload, '{booking}',
      (coalesce(v_payload -> 'booking', '{}'::jsonb) - 'staff_id' - 'bay_id' - 'resource_id')
        || jsonb_build_object('customer_id', auth.uid(), 'status', 'scheduled', 'is_walk_in', false));
    v_payload := jsonb_set(v_payload, '{vehicles}',
      (select jsonb_agg(jsonb_set(v, '{vehicle,status}', '"SCHEDULED"', true)) from jsonb_array_elements(v_payload -> 'vehicles') v));
  end if;

  perform public.assert_booking_pricing(v_payload);
  v_payment := v_payload -> 'payment';
  v_method := upper(coalesce(v_payment ->> 'method', ''));
  v_is_admin_walk_in := coalesce((v_payload #>> '{booking,is_walk_in}')::boolean, false) and v_is_admin;
  v_requires_scan := v_payment is not null
    and jsonb_typeof(v_payment) = 'object'
    and v_method not in ('', 'CASH')
    and not v_is_admin_walk_in;

  if nullif(v_payment ->> 'ocr_scan_id', '') is not null then
    v_scan_id := (v_payment ->> 'ocr_scan_id')::uuid;
  elsif v_requires_scan then
    raise exception 'A current server-verified receipt scan is required.'
      using errcode = '23514';
  end if;

  if v_scan_id is not null then
    select * into v_scan
      from public.ocr_scan_sessions
     where id = v_scan_id
       and active
       and expires_at > now()
     for update;

    if not found then
      raise exception 'The receipt scan is missing, expired, or already used. Scan the receipt again.'
        using errcode = '23514';
    end if;

    v_verdict := case when v_is_admin_walk_in
      then upper(coalesce(v_payment ->> 'verdict', 'PAID'))
      else v_scan.payment_verdict
    end;
    v_metadata := jsonb_set(v_scan.ocr_metadata, '{payment_verdict}', to_jsonb(v_verdict), true);
    if not v_is_admin_walk_in then
      v_total_amount := nullif(v_payload #>> '{booking,total_amount}', '')::numeric;
      v_payment_type := lower(coalesce(v_payment ->> 'payment_type', 'full'));
      if v_total_amount is null or v_total_amount <= 0 then
        raise exception 'A valid booking total is required for receipt verification.'
          using errcode = '23514';
      end if;
      if v_payment_type = 'downpayment' then
        v_required_amount := public.booking_required_downpayment(v_total_amount);
      elsif v_payment_type = 'full' then
        v_required_amount := v_total_amount;
      else
        raise exception 'Unsupported customer payment type for receipt verification.'
          using errcode = '23514';
      end if;
      if not coalesce((v_metadata ->> 'extraction_unavailable')::boolean, false)
        and abs(coalesce(nullif(v_metadata ->> 'requiredAmount', '')::numeric, -1) - v_required_amount) > 0.01 then
        raise exception 'The booking total changed after the receipt was scanned. Scan the receipt again.'
          using errcode = '23514';
      end if;
      v_scanned_amount := nullif(v_metadata ->> 'amount', '')::numeric;
      if not coalesce((v_metadata ->> 'extraction_unavailable')::boolean, false)
         and coalesce(v_scanned_amount, 0) < v_required_amount - 1.00 then
        raise exception 'The scanned receipt is below the required payment amount.'
          using errcode = '23514';
      end if;
    end if;
    v_payment := jsonb_set(v_payment, '{verdict}', to_jsonb(v_verdict), true);
    if not v_is_admin_walk_in then
      v_payment := jsonb_set(v_payment, '{status}', to_jsonb('FOR_VERIFICATION'::text), true);
      v_payload := jsonb_set(v_payload, '{booking,payment_status}', to_jsonb('pending'::text), true);
    end if;
    v_payment := jsonb_set(v_payment, '{detected_amount}', coalesce(v_metadata -> 'amount', 'null'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{detected_ref}', coalesce(v_metadata -> 'referenceNumber', 'null'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{reference_number}', coalesce(v_metadata -> 'referenceNumber', 'null'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{receipt_url}', coalesce(v_metadata -> 'receipt_url', 'null'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{amount}', to_jsonb(v_required_amount), true);
    v_payment := jsonb_set(v_payment, '{transfer_fee}', coalesce(v_metadata -> 'transferFee', '0'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{net_credit}', coalesce(v_metadata -> 'amount', 'null'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{ocr_metadata}', v_metadata, true);
    v_payload := jsonb_set(v_payload, '{payment}', v_payment, true);
    v_payload := jsonb_set(v_payload, '{booking,ocr_metadata}', v_metadata, true);
  elsif not v_is_admin_walk_in and v_payment is not null and jsonb_typeof(v_payment) = 'object' then
    v_payment := jsonb_set(v_payment, '{status}', to_jsonb('PENDING'::text), true);
    v_payload := jsonb_set(v_payload, '{payment}', v_payment, true);
    if v_method = 'CASH' then
      v_payload := jsonb_set(v_payload, '{booking,payment_status}', to_jsonb('unpaid'::text), true);
    end if;
  end if;

  v_result := public.create_booking_atomic(v_payload);
  v_booking_id := nullif(v_result #>> '{booking,id}', '')::uuid;
  v_payment_id := nullif(v_result #>> '{payment,id}', '')::uuid;

  -- the row check counted the booking as one bay; check all of its vehicles now that they are written
  if not public.slot_has_capacity((v_result #>> '{booking,start_datetime}')::timestamptz, (v_result #>> '{booking,end_datetime}')::timestamptz,
                                  v_booking_id, ceil(internal.booking_bay_usage(v_booking_id))::integer) then
    raise exception 'The selected time is full. Please choose another appointment time.' using errcode = '23514';
  end if;

  -- a walk-in paid only in part is partially paid
  if v_result #>> '{booking,payment_status}' = 'paid'
     and coalesce((v_result #>> '{payment,amount}')::numeric, 0) < coalesce((v_result #>> '{booking,total_amount}')::numeric, 0) - 0.01 then
    update public.bookings set payment_status = 'partially_paid' where id = v_booking_id;
    v_result := jsonb_set(v_result, '{booking,payment_status}', '"partially_paid"');
  end if;

  if v_scan_id is not null then
    if v_booking_id is null or v_payment_id is null then
      raise exception 'The booking did not create a payment for its receipt scan.';
    end if;

    update public.payments
       set ocr_evaluated_total = coalesce(ocr_evaluated_total, nullif(v_payload #>> '{booking,total_amount}', '')::numeric),
           ocr_evaluated_at = coalesce(ocr_evaluated_at, now())
     where id = v_payment_id
       and booking_id = v_booking_id;

    if not found then
      raise exception 'Could not attach the OCR receipt hash to its payment.';
    end if;

    update public.ocr_scan_sessions
       set active = false,
           booking_id = v_booking_id,
           payment_id = v_payment_id
     where id = v_scan_id;
  end if;

  return v_result;
end;
$function$;
