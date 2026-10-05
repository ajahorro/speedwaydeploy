-- ============================================================================
-- 3.10 Customer "Pay remaining balance".
--
-- A customer who already paid a downpayment submits proof of the second payment. The receipt
-- is read by the backend OCR (a server-issued scan session); this function turns that scan into
-- ONE payment awaiting admin verification, with the same protections as booking creation:
--   * only the booking's own customer, only while the booking is open and has a balance;
--   * the balance is taken from the ledger here, never from the browser;
--   * the scan must be current, unused, and made for exactly this balance;
--   * a receipt below the balance is refused (nothing stored); equal or above is accepted, the
--     excess following the existing overpayment/credit logic;
--   * the reference number stays single-use (payments.reference_number is unique);
--   * the scan is consumed, so the same receipt cannot be submitted twice.
-- Amounts already awaiting verification count toward the balance, so a customer cannot submit
-- the same balance twice.
-- ============================================================================
create or replace function public.submit_balance_payment(p_booking_id uuid, p_ocr_scan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_booking public.bookings%rowtype;
  v_ledger record;
  v_scan public.ocr_scan_sessions%rowtype;
  v_balance numeric;
  v_meta jsonb;
  v_scanned numeric;
  v_manual boolean;
  v_payment_id uuid;
  v_ref text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to pay your balance.' using errcode = '42501';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found or v_booking.customer_id is distinct from auth.uid() then
    raise exception 'Booking not found.' using errcode = '42501';
  end if;
  if lower(coalesce(v_booking.status::text, '')) in ('cancelled', 'completed', 'released', 'flagged_noshow', 'no_show') then
    raise exception 'This booking is closed, so a balance payment cannot be added.' using errcode = '23514';
  end if;

  select * into v_ledger from public.booking_ledger_v where booking_id = p_booking_id;
  v_balance := round(coalesce(v_ledger.submitted_balance_due, 0), 2);
  if v_balance <= 0 then
    raise exception 'There is no balance left to pay on this booking.' using errcode = '23514';
  end if;

  select * into v_scan
    from public.ocr_scan_sessions
   where id = p_ocr_scan_id and active and expires_at > now()
   for update;
  if not found then
    raise exception 'The receipt scan is missing, expired, or already used. Scan the receipt again.' using errcode = '23514';
  end if;
  if upper(coalesce(v_scan.payment_verdict, '')) <> 'FOR_VERIFICATION' then
    raise exception 'This receipt was not accepted. Scan a valid receipt.' using errcode = '23514';
  end if;

  v_meta := coalesce(v_scan.ocr_metadata, '{}'::jsonb);
  v_manual := coalesce((v_meta ->> 'extraction_unavailable')::boolean, false);
  if abs(coalesce(nullif(v_meta ->> 'requiredAmount', '')::numeric, -1) - v_balance) > 0.01 then
    raise exception 'Your balance changed after the receipt was scanned. Scan the receipt again.' using errcode = '23514';
  end if;
  v_scanned := nullif(v_meta ->> 'amount', '')::numeric;
  if not v_manual and coalesce(v_scanned, 0) < v_balance - 1.00 then
    raise exception 'The receipt shows less than the balance of %. Pay the full balance and scan again.', v_balance using errcode = '23514';
  end if;

  v_ref := nullif(btrim(coalesce(v_meta ->> 'referenceNumber', v_meta ->> 'referenceNo', '')), '');

  insert into public.payments (
    booking_id, amount, method, status, payment_type, receipt_url,
    reference_number, detected_ref, detected_amount, transfer_fee, net_credit,
    ocr_evaluated_total, ocr_evaluated_at, notes
  ) values (
    p_booking_id, v_balance, 'GCash', 'FOR_VERIFICATION', 'Full', v_meta ->> 'receipt_url',
    v_ref, v_ref, v_scanned, coalesce(nullif(v_meta ->> 'transferFee', '')::numeric, 0), v_scanned,
    v_booking.total_amount, now(),
    'PAYMENT_GCASH | BALANCE_PAYMENT | CUSTOMER_SUBMITTED' || case when v_manual then ' | MANUAL_REVIEW' else '' end
  ) returning id into v_payment_id;

  update public.ocr_scan_sessions
     set active = false, booking_id = p_booking_id, payment_id = v_payment_id
   where id = p_ocr_scan_id;

  return jsonb_build_object('payment_id', v_payment_id, 'amount', v_balance, 'detected_amount', v_scanned, 'manual_review', v_manual);
exception
  when unique_violation then
    raise exception 'This payment reference has already been used. Check the receipt.' using errcode = '23505';
end;
$fn$;

revoke all on function public.submit_balance_payment(uuid, uuid) from public, anon;
grant execute on function public.submit_balance_payment(uuid, uuid) to authenticated;
