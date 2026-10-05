/**
 * paymentUtils.js
 *
 * PRESENTATION helpers for booking money. This file does not compute money:
 * every paid / balance / credit / refund figure comes from the database ledger
 * (public.booking_ledger_v, read through services/ledgerService.js) and is
 * attached to a booking as `booking.ledger`. Summing `payments` rows here is
 * what used to make screens disagree, so it is deliberately not possible.
 *
 * The downpayment policy is the shop's configured policy from business_config
 * (shop_downpayment_policy()), loaded by ConfigContext via setDownpaymentPolicy.
 * The server re-checks every amount with the same policy.
 */

// ── Downpayment policy (mirrors business_config; defaults = shop defaults) ──
const DEFAULT_DOWNPAYMENT_POLICY = Object.freeze({ min_total: 1000, rate: 0.3, high_threshold: 2000, high_rate: 0.5 });
let downpaymentPolicy = DEFAULT_DOWNPAYMENT_POLICY;

/** Called by ConfigContext with the result of shop_downpayment_policy(). */
export const setDownpaymentPolicy = (policy) => {
  if (!policy) return;
  downpaymentPolicy = {
    min_total: Number(policy.min_total ?? DEFAULT_DOWNPAYMENT_POLICY.min_total),
    rate: Number(policy.rate ?? DEFAULT_DOWNPAYMENT_POLICY.rate),
    high_threshold: Number(policy.high_threshold ?? DEFAULT_DOWNPAYMENT_POLICY.high_threshold),
    high_rate: Number(policy.high_rate ?? DEFAULT_DOWNPAYMENT_POLICY.high_rate)
  };
};

export const getDownpaymentPolicy = () => downpaymentPolicy;

const EMPTY_LEDGER = Object.freeze({
  original_amount: 0,
  expected_amount: 0,
  settled_amount: 0,
  refunded_amount: 0,
  net_settled: 0,
  verified_paid: 0,
  outstanding_amount: 0,
  excess_amount: 0,
  pending_verification: 0,
  has_pending_verification: false,
  cancelled_no_fee: false,
  downpayment_met: false,
  paid_status: 'unpaid'
});

export const calculatePaymentStatus = (booking) => calculatePaymentSummary(booking).status;

/**
 * Booking payment summary, mapped from the ledger row on `booking.ledger`.
 *
 *   totalPaid  : net money held for the booking (ledger net_settled)
 *   balance    : still owed (ledger outstanding_amount, never negative)
 *   credit     : overpaid amount held for the customer (ledger excess_amount)
 *   netBalance : signed balance; negative = credit
 *
 * When the ledger has not loaded yet the summary reports zero paid and the
 * full total due, with `ledgerLoaded: false` so callers can show a loader.
 */
export const calculatePaymentSummary = (booking = {}) => {
  const ledger = booking.ledger || null;
  const row = ledger || {
    ...EMPTY_LEDGER,
    original_amount: Number(booking.total_amount || 0),
    expected_amount: Number(booking.total_amount || 0),
    outstanding_amount: Number(booking.total_amount || 0)
  };

  const totalAmount = Number(row.original_amount || 0);
  const effectiveTotalAmount = Number(row.expected_amount || 0);
  const totalPaid = Number(row.net_settled || 0);
  const processedRefunds = Number(row.refunded_amount || 0);
  const balance = Number(row.outstanding_amount || 0);
  const credit = Number(row.excess_amount || 0);
  const refundStatus = String(booking.refund_status || '').toUpperCase();
  const hasProcessedRefund = processedRefunds > 0 || ['PROCESSED', 'REFUNDED', 'RELEASED'].includes(refundStatus);

  let status = 'UNPAID';
  switch (row.paid_status) {
    case 'refunded':
      status = 'REFUNDED';
      break;
    case 'void':
      status = 'NO_CHARGE';
      break;
    case 'paid':
    case 'overpaid':
      status = 'PAID';
      break;
    default:
      if (row.has_pending_verification) status = 'VERIFYING';
      else if (row.downpayment_met && totalPaid > 0) status = 'DOWNPAYMENT_PAID';
      else if (row.paid_status === 'partially_refunded') status = 'PARTIALLY_REFUNDED';
  }

  return {
    status,
    totalAmount,
    effectiveTotalAmount,
    totalPaid,
    verifiedPaid: Number(row.verified_paid || 0),
    processedRefunds,
    balance,
    credit,
    netBalance: balance > 0 ? balance : -credit,
    hasProcessedRefund,
    isOverpaid: credit > 0,
    isCancelledNoFee: Boolean(row.cancelled_no_fee),
    requiredDownpayment: Number(row.required_downpayment || 0),
    downpaymentMet: Boolean(row.downpayment_met),
    paidInFull: Boolean(row.service_paid_in_full),
    ledgerLoaded: Boolean(ledger)
  };
};

/**
 * Scenario 10 — credit the shop owes (positive) or is owed (negative) if the
 * booking total became `newTotalAmount`.
 */
export const calculateAdjustmentCredit = (booking = {}, newTotalAmount = null) => {
  const { totalPaid } = calculatePaymentSummary(booking);
  const target = newTotalAmount === null || newTotalAmount === undefined
    ? Number(booking.total_amount || 0)
    : Number(newTotalAmount || 0);
  return Math.round((totalPaid - target) * 100) / 100;
};

export const requiresDownpayment = (totalAmount) => Number(totalAmount || 0) >= downpaymentPolicy.min_total;

/**
 * Downpayment for an amount, with the tier chosen by the booking's CART total
 * (never by an individual line item) using the shop's configured policy.
 *
 * @param {number} amountToCover  the figure the percentage is applied to
 * @param {number} [cartTotal]    the booking grand total that picks the tier
 */
export const calculateRequiredDownpayment = (amountToCover, cartTotal = null) => {
  const base = Number(amountToCover || 0);
  const tierBasis = cartTotal === null || cartTotal === undefined ? base : Number(cartTotal || 0);
  const rate = tierBasis >= downpaymentPolicy.high_threshold ? downpaymentPolicy.high_rate : downpaymentPolicy.rate;
  return {
    percentage: Math.round(rate * 100),
    basis: tierBasis,
    amount: Math.round(base * rate * 100) / 100
  };
};

/** Convenience: downpayment for a line item, tiered by the booking's cart total. */
export const getRequiredDownpaymentForCart = (amountToCover, cartTotal) =>
  calculateRequiredDownpayment(amountToCover, cartTotal).amount;

export const getRequiredDownpayment = (totalAmount) => calculateRequiredDownpayment(totalAmount).amount;

export const calculateAdditionalDownpayment = (newBookingTotal, verifiedPaid, addedServicePrice) => {
  const requiredForBooking = getRequiredDownpayment(newBookingTotal);
  const paid = Math.max(0, Number(verifiedPaid) || 0);
  const servicePrice = Math.max(0, Number(addedServicePrice) || 0);
  return Math.min(servicePrice, Math.max(0, requiredForBooking - paid));
};

export const getPaymentStatusUI = (status) => {
  switch (status) {
    case 'PAID':
      return { label: 'FULLY PAID', color: 'var(--status-success)' };
    case 'REFUNDED':
      return { label: 'REFUNDED', color: 'var(--status-danger)' };
    case 'PARTIALLY_REFUNDED':
      return { label: 'PARTIAL REFUND', color: 'var(--status-warning)' };
    case 'VERIFYING':
      return { label: 'VERIFYING', color: 'var(--status-accent)' };
    case 'NO_CHARGE':
      return { label: 'NO CHARGE', color: 'var(--admin-text-secondary)' };
    case 'DOWNPAYMENT_PAID':
      return { label: 'DOWNPAYMENT', color: 'var(--status-info)' };
    default:
      return { label: 'UNPAID', color: 'var(--status-danger)' };
  }
};

/**
 * derivePaymentStatusBadge
 *
 * Derives the payment status badge strictly from the financial ledger.
 * NEVER reads booking.payment_status directly — only totalPaid vs totalAmount.
 *
 * @param {object} booking   - booking row (must include total_amount + payments[])
 * @param {object} [summary] - pre-computed calculatePaymentSummary() result (optional)
 * @returns {{ statusKey, text, shortText, color, balance, subtext? }}
 */
export const derivePaymentStatusBadge = (booking = {}, summary = null) => {
  const ps = summary || calculatePaymentSummary(booking);
  const totalAmount = Number(booking.total_amount || 0);
  const { totalPaid, balance, hasProcessedRefund } = ps;

  const billingType = (booking.billing_type || '').toUpperCase();
  const isFleetAccount =
    billingType === 'FLEET' ||
    booking.customer_type === 'fleet' ||
    booking.fleet_account_id != null ||
    booking.fleet_group_id != null;

  if (isFleetAccount && totalPaid === 0) {
    return {
      statusKey: 'FLEET_BILLING',
      text: 'Billed to Corporate Account',
      shortText: 'Fleet Billed',
      color: 'var(--status-accent)',
      balance,
      subtext: 'Account Invoice Pending',
    };
  }

  if (hasProcessedRefund && totalPaid === 0) {
    return {
      statusKey: 'REFUNDED',
      text: 'Refunded',
      shortText: 'Refunded',
      color: 'var(--status-danger)',
      balance: 0,
    };
  }

  if (totalAmount === 0 || totalPaid === 0) {
    return {
      statusKey: 'UNPAID',
      text: 'Unpaid',
      shortText: 'Unpaid',
      color: 'var(--status-danger)',
      balance: totalAmount,
      subtext: `\u20b1${totalAmount.toLocaleString()} outstanding`,
    };
  }

  if (totalPaid >= totalAmount) {
    return {
      statusKey: 'FULLY_PAID',
      text: 'Fully Paid',
      shortText: 'Paid',
      color: 'var(--status-success)',
      balance: 0,
    };
  }

  return {
    statusKey: 'PARTIALLY_PAID',
    text: 'Partially Paid',
    shortText: 'Partial',
    color: 'var(--status-warning)',
    balance,
    subtext: `\u20b1${balance.toLocaleString()} remaining`,
  };
};

