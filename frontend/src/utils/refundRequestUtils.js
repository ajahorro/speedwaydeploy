/**
 * Excess ("overpayment credit") refund still owed on ONE booking: the credit the
 * customer queued (REFUND_QUEUED ledger entries, stored as negatives) minus the
 * overpayment refunds already paid out (negative SYSTEM_REFUND payment rows whose
 * note starts with OVERPAYMENT_CREDIT_REFUND:).
 *
 * The admin dashboard count and the Refunds page must always agree, so both call
 * this instead of each keeping its own copy of the arithmetic.
 *
 * Only a COMPLETED booking keeps an excess-only refund. A cancelled or no-show booking is refunded from everything
 * that was paid (the excess is part of it), so its queued excess is not a separate refund and counts as 0 here.
 *
 * @param {{ creditEntries?: {amount:number}[], payments?: object[], bookingStatus?: string }} input
 *   creditEntries: the REFUND_QUEUED customer_credit_ledger rows of this booking.
 *   payments: this booking's payment rows.
 */
export const getOverpaymentRefundRemaining = ({ creditEntries = [], payments = [], bookingStatus } = {}) => {
  if (bookingStatus !== undefined && String(bookingStatus || '').trim().toLowerCase() !== 'completed') return 0;
  const queued = (creditEntries || [])
    .reduce((sum, entry) => sum + Math.max(0, -Number(entry?.amount || 0)), 0);
  const processed = (payments || [])
    .filter((payment) => Number(payment?.amount) < 0
      && String(payment?.method || '').trim().toUpperCase() === 'SYSTEM_REFUND'
      && String(payment?.notes || '').startsWith('OVERPAYMENT_CREDIT_REFUND:'))
    .reduce((sum, payment) => sum + Math.abs(Number(payment.amount)), 0); // single-source-ok: matches overpayment-credit refund rows by note; not a paid total
  return Math.max(0, queued - processed);
};

export const getRefundRequestLimit = ({ totalPaid = 0, overpaymentRefundRemaining = 0 }) => {
  const remainingCreditRefund = Math.max(0, Number(overpaymentRefundRemaining) || 0);
  return remainingCreditRefund > 0
    ? remainingCreditRefund
    : Math.max(0, Number(totalPaid) || 0);
};

export const isPendingRefundRequest = ({ refundStatus, refundLimit }) => (
  ['PENDING', 'QUEUED', 'PROCESSING', 'EMAIL_PENDING'].includes(
    String(refundStatus || 'QUEUED').trim().toUpperCase()
  ) && Number(refundLimit) > 0
);
