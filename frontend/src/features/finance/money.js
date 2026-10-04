/**
 * Presentation helpers for money. Formatting only — every value passed in must
 * already come from the ledger (services/ledgerService.js).
 */
const pesoFormatter = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const compactFormatter = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  notation: 'compact',
  maximumFractionDigits: 1
});

export const formatPeso = (value) => pesoFormatter.format(Number(value || 0));
export const formatPesoCompact = (value) => compactFormatter.format(Number(value || 0));

/** Labels for booking_ledger_v.paid_status. */
export const PAID_STATUS_LABELS = {
  unpaid: 'Unpaid',
  pending: 'Pending verification',
  partial: 'Partially paid',
  paid: 'Paid',
  overpaid: 'Overpaid',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
  void: 'No charge'
};

export const PAYMENT_METHOD_LABELS = {
  GCASH: 'GCash',
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  MAYA: 'Maya',
  SYSTEM_REFUND: 'Refund',
  CREDIT: 'Store credit'
};

export const formatMethod = (method) => {
  const key = String(method || '').toUpperCase();
  return PAYMENT_METHOD_LABELS[key] || (key ? key.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : 'Unknown');
};
