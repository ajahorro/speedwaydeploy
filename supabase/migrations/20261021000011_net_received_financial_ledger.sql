-- Recognize only money received by the shop. OCR `detected_amount` is already
-- net of `transfer_fee`; the fee remains visible separately but is not revenue,
-- booking credit, or excess credit.

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
        when coalesce(detected_amount, 0) > 0 then coalesce(detected_amount, 0)
        else amount
      end
    ), 0) as total
      from public.payments
     where booking_id = p_booking_id
       and (
         case
           when coalesce(detected_amount, 0) > 0 then coalesce(detected_amount, 0)
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
  'Settled funds received by the shop: detected_amount is already net of transfer_fee; legacy rows fall back to amount; refunds are subtracted once.';

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
  v_booking public.bookings%rowtype;
  v_original numeric := 0;
  v_expected numeric := 0;
  v_settled numeric := 0;
  v_refunded numeric := 0;
  v_pending numeric := 0;
  v_ocr_detected numeric := 0;
  v_ocr_declared numeric := 0;
  v_transfer_fee numeric := 0;
  v_credit_applied numeric := 0;
  v_ocr_status text;
  v_ocr_ref text;
  v_variance numeric := 0;
  v_cancelled_no_fee boolean := false;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then
    raise exception 'booking_financial_ledger: booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  v_original := coalesce(v_booking.total_amount, 0);
  v_expected := v_original;

  select coalesce(sum(
    case
      when coalesce(detected_amount, 0) > 0 then coalesce(detected_amount, 0)
      else amount
    end
  ), 0)
    into v_settled
    from public.payments
   where booking_id = p_booking_id
     and (
       case
         when coalesce(detected_amount, 0) > 0 then coalesce(detected_amount, 0)
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

  v_cancelled_no_fee := upper(coalesce(v_booking.status, '')) = 'CANCELLED'
    and v_settled <= 0
    and v_pending <= 0;
  if v_cancelled_no_fee then
    v_expected := 0;
  end if;

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'original_amount', round(v_original, 2),
    'expected_amount', round(v_expected, 2),
    'cancelled_no_fee', v_cancelled_no_fee,
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
    'ledger_rule', 'settled = OCR net amount received; transfer fee is reported separately; FOR_VERIFICATION remains excluded'
  );
end;
$$;

comment on function public.booking_financial_ledger(uuid) is
  'Settled booking ledger uses OCR net amount received; transfer fees remain separately reported and are not added to recognized funds.';

revoke all on function public.booking_financial_ledger(uuid) from public;
grant execute on function public.booking_financial_ledger(uuid) to authenticated;

create or replace function public.booking_verified_paid(p_booking_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select greatest(0,
    coalesce(sum(
      case when coalesce(detected_amount, 0) > 0
        then detected_amount
        else amount
      end
    ) filter (
      where amount > 0
        and upper(coalesce(status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED')
        and upper(coalesce(method, '')) <> 'SYSTEM_REFUND'
    ), 0)
    - coalesce(sum(abs(amount)) filter (
      where amount < 0
        and (upper(coalesce(method, '')) = 'SYSTEM_REFUND'
             or upper(coalesce(status, '')) = 'REFUNDED')
    ), 0)
  )::numeric
    from public.payments
   where booking_id = p_booking_id;
$$;

-- Existing credit entries were seeded using detected_amount + transfer_fee.
-- Reconcile affected bookings against the corrected net-only verified total.
do $net_credit_backfill$
declare
  v_booking record;
begin
  for v_booking in
    select id
      from public.bookings
     where id in (select booking_id from public.payments where booking_id is not null)
        or id in (select booking_id from public.customer_credit_ledger where booking_id is not null)
  loop
    perform public.reconcile_booking_excess_credit(v_booking.id);
  end loop;
end;
$net_credit_backfill$;