-- ============================================================================
-- OCR truth for settled payment totals
-- ============================================================================
-- A customer can submit a downpayment amount (payments.amount) while OCR reads
-- the actual receipt amount into payments.detected_amount. Once an admin settles
-- that payment, the OCR amount is authoritative; otherwise balances, portal
-- totals, and emails can continue reporting the stale submitted amount.
-- FOR_VERIFICATION remains excluded from recognized revenue by design.

create or replace function public.booking_net_paid(p_booking_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with credits as (
    select coalesce(sum(
      case
        when coalesce(detected_amount, 0) > 0
          then coalesce(detected_amount, 0) + greatest(0, coalesce(transfer_fee, 0))
        else amount
      end
    ), 0) as total
      from public.payments
     where booking_id = p_booking_id
       and (
         case
           when coalesce(detected_amount, 0) > 0
             then coalesce(detected_amount, 0) + greatest(0, coalesce(transfer_fee, 0))
           else amount
         end
       ) > 0
       and upper(coalesce(method, '')) <> 'SYSTEM_REFUND'
       and upper(coalesce(status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED')
  ),
  refunds as (
    select coalesce(sum(abs(amount)), 0) as total
      from public.payments
     where booking_id = p_booking_id
       and (
         upper(coalesce(method, '')) = 'SYSTEM_REFUND'
         or upper(coalesce(status, '')) = 'REFUNDED'
       )
       and amount < 0
  )
  select greatest(0, (select total from credits) - (select total from refunds));
$$;

comment on function public.booking_net_paid(uuid) is
  'Canonical settled ledger: OCR detected amount plus transfer fee replaces a stale submitted amount for settled payments; FOR_VERIFICATION remains excluded; refunds are subtracted once.';

revoke all on function public.booking_net_paid(uuid) from public;
grant execute on function public.booking_net_paid(uuid) to authenticated;

create or replace function public.booking_financial_ledger(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_booking        public.bookings%rowtype;
  v_expected       numeric := 0;
  v_settled        numeric := 0;
  v_refunded       numeric := 0;
  v_pending        numeric := 0;
  v_ocr_detected   numeric := 0;
  v_ocr_declared   numeric := 0;
  v_transfer_fee   numeric := 0;
  v_credit_applied numeric := 0;
  v_ocr_status     text;
  v_ocr_ref        text;
  v_variance       numeric := 0;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then
    raise exception 'booking_financial_ledger: booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  v_expected := coalesce(v_booking.total_amount, 0);

  -- OCR is authoritative only after settlement; pending money stays attributed
  -- below and cannot inflate recognized revenue.
  select coalesce(sum(
    case
      when coalesce(detected_amount, 0) > 0
        then coalesce(detected_amount, 0) + greatest(0, coalesce(transfer_fee, 0))
      else amount
    end
  ), 0)
    into v_settled
    from public.payments
   where booking_id = p_booking_id
     and (
       case
         when coalesce(detected_amount, 0) > 0
           then coalesce(detected_amount, 0) + greatest(0, coalesce(transfer_fee, 0))
         else amount
       end
     ) > 0
     and upper(coalesce(status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and upper(coalesce(method, '')) <> 'SYSTEM_REFUND';

  select coalesce(sum(abs(amount)), 0)
    into v_refunded
    from public.payments
   where booking_id = p_booking_id
     and amount < 0
     and (upper(coalesce(method, '')) = 'SYSTEM_REFUND'
          or upper(coalesce(status, '')) = 'REFUNDED');

  select
    coalesce(sum(amount), 0),
    coalesce(sum(coalesce(detected_amount, 0)), 0),
    coalesce(sum(coalesce(transfer_fee, 0)), 0),
    coalesce(sum(coalesce(credit_applied, 0)), 0),
    (array_agg(upper(coalesce(status, '')) order by created_at desc))[1],
    (array_agg(coalesce(detected_ref, reference_number) order by created_at desc))[1]
    into v_pending, v_ocr_detected, v_transfer_fee, v_credit_applied, v_ocr_status, v_ocr_ref
    from public.payments
   where booking_id = p_booking_id
     and upper(coalesce(status, '')) = 'FOR_VERIFICATION';

  select coalesce(sum(amount), 0)
    into v_ocr_declared
    from public.payments
   where booking_id = p_booking_id
     and upper(coalesce(status, '')) = 'FOR_VERIFICATION';

  if v_ocr_detected > 0 then
    v_variance := round(v_ocr_declared - v_ocr_detected, 2);
  end if;

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'expected_amount', v_expected,
    'settled_amount', round(v_settled, 2),
    'refunded_amount', round(v_refunded, 2),
    'net_settled', round(greatest(0, v_settled - v_refunded), 2),
    'outstanding_amount', round(greatest(0, v_expected - (v_settled - v_refunded)), 2),
    'excess_amount', round(greatest(0, (v_settled - v_refunded) - v_expected), 2),
    'pending_verification', round(v_pending, 2),
    'pending_ocr_detected', round(v_ocr_detected, 2),
    'pending_declared', round(v_ocr_declared, 2),
    'ocr_variance', v_variance,
    'ocr_transfer_fee', round(v_transfer_fee, 2),
    'credit_applied', round(v_credit_applied, 2),
    'ocr_status', v_ocr_status,
    'ocr_reference', v_ocr_ref,
    'has_pending_verification', v_pending > 0,
    'has_ocr_data', v_ocr_detected > 0,
    'has_discrepancy', v_ocr_detected > 0 and abs(v_variance) > 0.01,
    'fully_settled', v_settled - v_refunded >= v_expected and v_expected > 0,
    'ledger_rule', 'settled = OCR amount + transfer fee when available; FOR_VERIFICATION remains excluded'
  );
end;
$$;

comment on function public.booking_financial_ledger(uuid) is
  'Read-only booking ledger using OCR detected amount plus transfer fee for settled payments, while keeping pending OCR attribution separate from recognized revenue.';

revoke all on function public.booking_financial_ledger(uuid) from public;
grant execute on function public.booking_financial_ledger(uuid) to authenticated;
