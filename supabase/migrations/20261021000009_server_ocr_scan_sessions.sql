-- Bind customer digital bookings to server-read receipt images.

create table if not exists public.ocr_scan_sessions (
  id uuid primary key default gen_random_uuid(),
  image_hash text not null,
  ocr_metadata jsonb not null,
  payment_verdict text not null check (payment_verdict = 'FOR_VERIFICATION'),
  active boolean not null default true,
  expires_at timestamptz not null default (now() + interval '20 minutes'),
  booking_id uuid references public.bookings(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists ocr_scan_sessions_active_image_hash_uq
  on public.ocr_scan_sessions (image_hash)
  where active;

alter table public.ocr_scan_sessions enable row level security;
revoke all on public.ocr_scan_sessions from public, anon, authenticated;
grant all on public.ocr_scan_sessions to service_role;

create or replace function public.register_ocr_scan_session(
  p_image_hash text,
  p_ocr_metadata jsonb,
  p_payment_verdict text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_image_hash is null or p_image_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid OCR image hash';
  end if;
  if p_payment_verdict <> 'FOR_VERIFICATION' then
    raise exception 'Unsupported OCR scan verdict';
  end if;
  if exists (
    select 1
      from public.payments
     where ocr_metadata ->> 'image_hash' = p_image_hash
  ) then
    raise exception 'RECEIPT_IMAGE_ALREADY_USED'
      using errcode = '23505';
  end if;

  insert into public.ocr_scan_sessions (
    image_hash, ocr_metadata, payment_verdict, active, expires_at
  ) values (
    p_image_hash,
    coalesce(p_ocr_metadata, '{}'::jsonb) || jsonb_build_object('image_hash', p_image_hash),
    p_payment_verdict,
    true,
    now() + interval '20 minutes'
  )
  on conflict (image_hash) where active
  do update set
    ocr_metadata = excluded.ocr_metadata,
    payment_verdict = excluded.payment_verdict,
    expires_at = excluded.expires_at
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_ocr_scan_session(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.register_ocr_scan_session(text, jsonb, text) to service_role;

create or replace function public.create_booking_atomic_secure(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_payment jsonb;
  v_scan_id uuid;
  v_scan public.ocr_scan_sessions%rowtype;
  v_method text;
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
  v_payment := v_payload -> 'payment';
  v_method := upper(coalesce(v_payment ->> 'method', ''));
  v_is_admin_walk_in := coalesce((v_payload #>> '{booking,is_walk_in}')::boolean, false)
    and public.is_admin();
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
        v_required_amount := round(v_total_amount * case when v_total_amount >= 2000 then 0.50 else 0.30 end, 2);
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

  if v_scan_id is not null then
    if v_booking_id is null or v_payment_id is null then
      raise exception 'The booking did not create a payment for its receipt scan.';
    end if;

    update public.payments
      set ocr_metadata = coalesce(ocr_metadata, '{}'::jsonb) || v_metadata,
          ocr_evaluated_total = coalesce(ocr_evaluated_total, nullif(v_payload #>> '{booking,total_amount}', '')::numeric),
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
$$;

revoke all on function public.create_booking_atomic_secure(jsonb) from public, anon;
grant execute on function public.create_booking_atomic_secure(jsonb) to authenticated, service_role;

-- Callers must go through the wrapper so a browser cannot invent FOR_VERIFICATION.
revoke execute on function public.create_booking_atomic(jsonb) from authenticated;

-- The post-booking OCR path also keeps the image hash on the payment record.
do $persist_hash$
declare
  v_src text;
  v_patched text;
begin
  select pg_get_functiondef(p.oid)
    into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'persist_ocr_result'
   limit 1;

  if v_src is null then
    raise exception 'persist_ocr_result() is required before applying the OCR hash patch.';
  end if;
  if position('p_ocr_metadata -> ''image_hash''' in v_src) > 0 then
    return;
  end if;

  v_patched := replace(
    v_src,
    '         detected_ref = p_detected_ref,',
    '         detected_ref = p_detected_ref,' || chr(10) ||
    '         ocr_metadata = coalesce(ocr_metadata, ''{}''::jsonb) || case' || chr(10) ||
    '           when p_ocr_metadata ? ''image_hash'' then jsonb_build_object(''image_hash'', p_ocr_metadata -> ''image_hash'')' || chr(10) ||
    '           else ''{}''::jsonb' || chr(10) ||
    '         end,'
  );

  if v_patched = v_src then
    raise exception 'persist_ocr_result() hash update anchor was not found.';
  end if;

  execute v_patched;
end;
$persist_hash$;