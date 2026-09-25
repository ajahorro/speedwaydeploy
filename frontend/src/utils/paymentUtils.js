/**
 * paymentUtils.js
 * Centralized source of truth for calculating booking and payment statuses.
 */

export const calculatePaymentStatus = (booking) => {
  return calculatePaymentSummary(booking).status;
};

export const calculatePaymentSummary = (booking = {}) => {
  const payments = booking.payments || [];
  const totalAmount = Number(booking.total_amount || 0);

  // 🛡️ SCENARIO 10 FIX — LEDGER DESYNC ON PARTIAL REFUNDS.
  //
  // A partial refund is written as a NEGATIVE SYSTEM_REFUND row with
  // status = 'REFUNDED' (process_booking_refund). The previous credit filter
  // matched rows with status IN ('PAID','REFUND_PENDING','REFUNDED') AND
  // amount > 0 — but the refund filter ALSO matched any row with status
  // 'REFUNDED', so depending on row shape a partial refund could be subtracted
  // from the credits while the refund total ignored the sign, or the negative
  // row was picked up twice (once as a credit line, once as a refund). On the
  // ₱150-paid / ₱30-refunded / ₱110-new-total example this produced a ₱40
  // credit instead of ₱10.
  //
  // Canonical rule (mirrors public.booking_net_paid in the DB):
  //   credits = Σ positive, non-refund rows that are settled
  //             (PAID | REFUND_PENDING | REFUNDED)
  //   refunds = Σ |negative rows| where the row IS a refund
  //             (method SYSTEM_REFUND OR status REFUNDED — but only when the
  //             amount is negative, so a positive source line can never be
  //             mistaken for a refund)
  //   netPaid = max(0, credits − refunds)
  const isRefundRow = (payment) => String(payment.method || '').toUpperCase() === 'SYSTEM_REFUND';

  const positivePayments = payments
    .filter(payment => !isRefundRow(payment)
      && ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(String(payment.status || '').toUpperCase())
      && Number(payment.amount) > 0)
    .reduce((sum, payment) => sum + Number(payment.amount), 0);

  const processedRefunds = payments
    .filter(payment => (isRefundRow(payment)
      || String(payment.status || '').toUpperCase() === 'REFUNDED')
      && Number(payment.amount) < 0)
    .reduce((sum, payment) => sum + Math.abs(Number(payment.amount)), 0);

  const totalPaid = Math.max(0, positivePayments - processedRefunds);
  const refundStatus = String(booking.refund_status || '').toUpperCase();
  const hasProcessedRefund = ['PROCESSED', 'REFUNDED', 'RELEASED'].includes(refundStatus)
    || payments.some(payment => String(payment.method || '').toUpperCase() === 'SYSTEM_REFUND' && Number(payment.amount) < 0)
    || payments.some(payment => String(payment.status || '').toUpperCase() === 'REFUNDED');
  const isPendingVerification = payments.some(payment => String(payment.status || '').toUpperCase() === 'FOR_VERIFICATION');
  const requiredDownpayment = calculateRequiredDownpayment(totalAmount).amount;

  // 🛡️ HOTFIX Fix 2 — SIGNED BALANCE + CREDIT CARRY-FORWARD.
  //
  // `balance` used to be clamped with Math.max(0, ...), which SILENTLY DISCARDED
  // an overpayment: a customer who paid ₱2,000 against a ₱980 bill reported
  // balance 0 — indistinguishable from exactly-paid, and the ₱1,020 credit was
  // invisible to every caller (including the Add-Service coverage check).
  //
  // We now return THREE distinct figures so no caller can conflate them:
  //   balance   : still OWED by the customer (clamped at 0 — never negative)
  //   credit    : overpaid amount the shop holds for the customer (>= 0)
  //   netBalance: SIGNED truth (totalAmount − totalPaid); negative = credit
  const rawBalance = Math.round((totalAmount - totalPaid) * 100) / 100;
  const balance = Math.max(0, rawBalance);
  const credit = Math.max(0, -rawBalance);
  const netBalance = rawBalance;

  let status = 'UNPAID';
  // A refunded booking is only fully REFUNDED when the net credit has been
  // driven to zero. A PARTIAL refund must keep the booking's true paid balance,
  // otherwise the UI would label a still-owed booking as REFUNDED and hide the
  // outstanding balance (the same ₱10-vs-₱40 desync). We therefore only report
  // REFUNDED when the booking is settled at ₱0 net after the refund.
  if (hasProcessedRefund && totalPaid <= 0) status = 'REFUNDED';
  else if (totalAmount > 0 && totalPaid >= totalAmount) status = 'PAID';
  else if (isPendingVerification) status = 'VERIFYING';
  else if (totalPaid >= requiredDownpayment) status = 'DOWNPAYMENT_PAID';
  else if (hasProcessedRefund) status = 'PARTIALLY_REFUNDED';

  return { status, totalAmount, totalPaid, processedRefunds, balance, credit, netBalance, hasProcessedRefund, isOverpaid: credit > 0 };
};

/**
 * Scenario 10 — the exact credit the shop owes (or is owed by) the customer
 * after a refund, expressed so callers cannot invert the sign.
 *
 *   creditOwed = netPaid − currentTotal
 *
 * On the canonical example (₱150 paid, ₱30 refunded, new total ₱110) this
 * returns +10 — the shop owes ₱10. A more-is-owed result (₱40) is the defect
 * this function exists to prevent.
 */
export const calculateAdjustmentCredit = (booking = {}, newTotalAmount = null) => {
  const { totalPaid } = calculatePaymentSummary(booking);
  const target = newTotalAmount === null || newTotalAmount === undefined
    ? Number(booking.total_amount || 0)
    : Number(newTotalAmount || 0);
  return Math.round((totalPaid - target) * 100) / 100;
};

export const requiresDownpayment = (totalAmount) => Number(totalAmount || 0) >= 1000;

/**
 * 🔧 DEFECT A1 FIX — DOWNPAYMENT TIER BASIS.
 *
 * The 30% vs 50% TIER must be decided by the AGGREGATE CART TOTAL of the whole
 * booking, never by an individual line item. Previously the tier was computed
 * from whatever number was passed in, so adding a ₱500 service to a ₱2,300 cart
 * evaluated the tier against ₱500 (30%) instead of the ₱2,300 cart total (50%) —
 * the wrong tier on the wrong basis.
 *
 * @param {number} amountToCover  the figure the percentage is APPLIED to
 *                                (the outstanding balance for that line/service)
 * @param {number} [cartTotal]    the booking's GRAND TOTAL used to choose the
 *                                tier. Defaults to `amountToCover` so existing
 *                                single-argument callers keep working, but every
 *                                add-service path MUST pass the cart total.
 */
export const calculateRequiredDownpayment = (amountToCover, cartTotal = null) => {
  const base = Number(amountToCover || 0);
  // The tier is chosen from the CART total when supplied, else the base.
  const tierBasis = cartTotal === null || cartTotal === undefined
    ? base
    : Number(cartTotal || 0);
  const percentage = tierBasis >= 2000 ? 50 : 30;
  return {
    percentage,
    basis: tierBasis,
    amount: Math.round(base * (percentage / 100) * 100) / 100
  };
};

/** Convenience: downpayment for a line item, tiered by the booking's cart total. */
export const getRequiredDownpaymentForCart = (amountToCover, cartTotal) =>
  calculateRequiredDownpayment(amountToCover, cartTotal).amount;

export const getRequiredDownpayment = (totalAmount) => calculateRequiredDownpayment(totalAmount).amount;

export const getPaymentStatusUI = (status) => {
  switch (status) {
    case 'PAID':
      return { label: 'FULLY PAID', color: 'var(--status-success)' };
    case 'REFUNDED':
      return { label: 'REFUNDED', color: 'var(--status-danger)' };
    case 'PARTIALLY_REFUNDED':
      return { label: 'PARTIAL REFUND', color: '#f59e0b' };
    case 'VERIFYING':
      return { label: 'VERIFYING', color: '#8b5cf6' };
    case 'DOWNPAYMENT_PAID':
      return { label: 'DOWNPAYMENT', color: '#3b82f6' };
    default:
      return { label: 'UNPAID', color: 'var(--status-danger)' };
  }
};
