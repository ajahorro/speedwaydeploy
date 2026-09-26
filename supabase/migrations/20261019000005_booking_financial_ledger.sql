-- ============================================================================
-- 20261019000005_booking_financial_ledger.sql
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Two requirements were stated together:
--
--   (A) the OCR output must reflect in the booking's overall financial ledger
--   (B) a customer-made booking must still sit in payment VERIFICATION
--
-- These CONFLICT, and the conflict is the defect. The canonical ledger rule
-- (public.booking_net_paid, mirrored by frontend calculatePaymentSummary) counts
-- a payment as money received only when its status is one of:
--
--       PAID | REFUND_PENDING | REFUNDED
--
-- FOR_VERIFICATION is deliberately NOT in that set — which is correct, because
-- an unverified receipt must never inflate recognised revenue. The consequence,
-- measured against the live database, is that a customer's OCR-scanned payment
-- contributes **₱0** to the ledger: the OCR amount is written to
-- payments.detected_amount / detected_ref and bookings.ocr_metadata, and then
-- disappears from every financial total until an admin verifies it.
--
-- THE FIX (and why it is shaped this way)
-- ---------------------------------------
-- Do NOT widen the settled set. Instead make the OCR output visible in the
-- ledger as an ATTRIBUTION layer above the recognised totals:
--
--     settled_amount          money the business has actually recognised
--                             (unchanged: PAID-family statuses only)
--     pending_verification    money a customer says they paid, not yet verified
--     ocr_detected_amount     what the receipt scan actually read
--     ocr_variance            declared − OCR. Non-zero means the two disagree,
--                             which is precisely the number an admin needs in
--                             order to decide the verification.
--
-- Every field is returned SEPARATELY and named explicitly, because the original
-- defect class in this codebase was repeatedly "two figures silently merged"
-- (total_amount vs amount, gross vs net, base vs VAT). A caller cannot misread
-- a field it must name.
--
-- `expected_amount` is the booking total; `fully_settled` is only true when the
-- SETTLED money covers it, so an unverified claim can never read as paid.
--
-- READS ONLY: security invoker and no writes, so RLS on the underlying tables
-- still governs what a caller may see.
-- ============================================================================

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

  -- ── Settled money: the SAME rule as booking_net_paid. Do not widen this. ──
  select coalesce(sum(amount), 0)
    into v_settled
    from public.payments
   where booking_id = p_booking_id
     and amount > 0
     and upper(coalesce(status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and upper(coalesce(method, '')) <> 'SYSTEM_REFUND';

  select coalesce(sum(abs(amount)), 0)
    into v_refunded
    from public.payments
   where booking_id = p_booking_id
     and amount < 0
     and (upper(coalesce(method, '')) = 'SYSTEM_REFUND'
          or upper(coalesce(status, '')) = 'REFUNDED');

  -- ── OCR-attributed money: claimed by the customer, NOT yet recognised. ────
  -- Summed separately so it can never be mistaken for settled revenue.
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

  -- What the customer DECLARED on the pending rows (not what OCR read).
  select coalesce(sum(amount), 0)
    into v_ocr_declared
    from public.payments
   where booking_id = p_booking_id
     and upper(coalesce(status, '')) = 'FOR_VERIFICATION';

  -- declared − OCR. Positive => the customer declared MORE than the receipt
  -- shows (the shop received less than claimed). Negative => the receipt shows
  -- more than was declared. Either way it is the number an admin must resolve.
  if v_ocr_detected > 0 then
    v_variance := round(v_ocr_declared - v_ocr_detected, 2);
  end if;

  return jsonb_build_object(
    'booking_id', p_booking_id,

    -- Recognised money.
    'expected_amount', v_expected,
    'settled_amount', round(v_settled, 2),
    'refunded_amount', round(v_refunded, 2),
    'net_settled', round(greatest(0, v_settled - v_refunded), 2),
    'outstanding_amount', round(greatest(0, v_expected - (v_settled - v_refunded)), 2),
    'excess_amount', round(greatest(0, (v_settled - v_refunded) - v_expected), 2),

    -- Claimed but unverified — visible, attributed, and explicitly NOT revenue.
    'pending_verification', round(v_pending, 2),
    'pending_ocr_detected', round(v_ocr_detected, 2),
    'pending_declared', round(v_ocr_declared, 2),
    'ocr_variance', v_variance,
    'ocr_transfer_fee', round(v_transfer_fee, 2),
    'credit_applied', round(v_credit_applied, 2),
    'ocr_status', v_ocr_status,
    'ocr_reference', v_ocr_ref,

    -- Derived flags, so no caller has to re-derive the rule (and get it wrong).
    'has_pending_verification', v_pending > 0,
    'has_ocr_data', v_ocr_detected > 0,
    'has_discrepancy', v_ocr_detected > 0 and abs(v_variance) > 0.01,
    -- Settled money covers the bill. An unverified claim CANNOT make this true.
    'fully_settled', v_settled - v_refunded >= v_expected and v_expected > 0,
    'ledger_rule', 'settled = PAID|REFUND_PENDING|REFUNDED only; FOR_VERIFICATION is excluded by design'
  );
end;
$$;

comment on function public.booking_financial_ledger(uuid) is
  'The booking''s overall financial ledger in one place: recognised (settled) money, refunds, and the OCR-attributed but UNVERIFIED money kept separate. Exists because an OCR-scanned customer payment contributed ₱0 to the ledger while pending verification, making the scan invisible to every financial total. Read-only.';

revoke all on function public.booking_financial_ledger(uuid) from public;
grant execute on function public.booking_financial_ledger(uuid) to authenticated;