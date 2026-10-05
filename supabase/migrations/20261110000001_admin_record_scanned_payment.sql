-- ============================================================================
-- Admin records a DIGITAL payment from a scanned receipt.
--
-- The receipt is read by the backend OCR (a server-issued scan session). The amount, reference and
-- receipt image all come from that scan, never from what the admin types, so the stored payment
-- always matches the receipt. The payment is created already verified (the admin is standing
-- in front of it), then the existing reconcile/receipt flow runs from the browser as for cash.
--
--   * admins only; booking must be open;
--   * the scan must be current and unused (it is consumed here);
--   * the amount cannot exceed what is still owed on the booking (same cap as a cash top-up);
--   * the reference number stays single-use (payments.reference_number is unique).
-- ============================================================================
create or replace function public.admin_record_scanned_payment(
  p_booking_id uuid,
  p_ocr_scan_id uuid,
  p_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_booking public.bookings%rowtype;
  v_ledger record;
  v_scan public.ocr_scan_sessions%rowtype;
  v_meta jsonb;
  v_net numeric;
  v_gross numeric;
  v_fee numeric;
  v_ref text;
  v_owed numeric;
  v_payment_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an admin can record a payment.' using errcode = '42501';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;
  if lower(coalesce(v_booking.status::text, '')) in ('cancelled', 'released') then
    raise exception 'This booking is closed, so a payment cannot be added.' using errcode = '23514';
  end if;

  select * into v_scan
    from public.ocr_scan_sessions
   where id = p_ocr_scan_id and active and expires_at > now()
   for update;
  if not found then
    raise exception 'The receipt scan is missing, expired, or already used. Upload the receipt again.' using errcode = '23514';
  end if;
  if upper(coalesce(v_scan.payment_verdict, '')) <> 'FOR_VERIFICATION' then
    raise exception 'This receipt was not accepted. Upload a valid receipt.' using errcode = '23514';
  end if;

  v_meta := coalesce(v_scan.ocr_metadata, '{}'::jsonb);
  if coalesce((v_meta ->> 'extraction_unavailable')::boolean, false) then
    raise exception 'The receipt could not be read, so no amount is available. Ask for a clearer receipt.' using errcode = '23514';
  end if;

  v_net := nullif(v_meta ->> 'amount', '')::numeric;
  if coalesce(v_net, 0) <= 0 then
    raise exception 'The amount could not be read from the receipt.' using errcode = '23514';
  end if;
  v_gross := coalesce(nullif(v_meta ->> 'grossAmount', '')::numeric, v_net);
  v_fee := coalesce(nullif(v_meta ->> 'transferFee', '')::numeric, 0);

  select * into v_ledger from public.booking_ledger_v where booking_id = p_booking_id;
  v_owed := round(coalesce(v_ledger.outstanding_amount, 0), 2);
  if v_net > v_owed + 0.01 then
    raise exception 'The receipt shows more than what is still owed (%).', v_owed using errcode = '23514';
  end if;

  v_ref := coalesce(nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(v_meta ->> 'referenceNumber', v_meta ->> 'referenceNo', '')), ''));
  if v_ref is null or length(v_ref) < 4 then
    raise exception 'A reference number is needed.' using errcode = '23514';
  end if;

  insert into public.payments (
    booking_id, amount, method, status, payment_type, receipt_url,
    reference_number, detected_ref, detected_amount, transfer_fee, net_credit,
    verified_by, verified_at, ocr_evaluated_total, ocr_evaluated_at, notes
  ) values (
    p_booking_id, v_gross, 'GCash', 'PAID',
    (case when v_net >= v_owed - 0.01 then 'Full' else 'Manual' end)::public.payment_type_enum,
    v_meta ->> 'receipt_url',
    v_ref, nullif(btrim(coalesce(v_meta ->> 'referenceNumber', v_meta ->> 'referenceNo', '')), ''),
    v_net, v_fee, v_net,
    auth.uid(), now(), v_booking.total_amount, now(),
    'PAYMENT_DIGITAL | Scanned receipt recorded by Admin | REF:' || v_ref
  ) returning id into v_payment_id;

  update public.ocr_scan_sessions
     set active = false, booking_id = p_booking_id, payment_id = v_payment_id
   where id = p_ocr_scan_id;

  return jsonb_build_object('payment_id', v_payment_id, 'amount', v_net, 'reference', v_ref);
exception
  when unique_violation then
    raise exception 'That reference number has already been used on another payment.' using errcode = '23505';
end;
$fn$;

revoke all on function public.admin_record_scanned_payment(uuid, uuid, text) from public, anon;
grant execute on function public.admin_record_scanned_payment(uuid, uuid, text) to authenticated;
