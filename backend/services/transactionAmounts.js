/**
 * backend/services/transactionAmounts.js
 * ============================================================================
 * The backend twin of frontend/src/utils/paymentAmounts.js.
 *
 * The backend sends the OFFICIAL RECEIPT PDF + email, so it must use the SAME
 * money model as the UI. Two copies of "which amount did we mean?" is how the
 * receipt and the portal ended up quoting different figures.
 *
 * Kept as plain CommonJS with no imports so it can be unit-tested in isolation
 * (see tests/transaction_amounts.test.js) — the comparison logic here is what
 * decides whether an alert fires, so it must be verifiable without a live DB.
 *
 * NOTE on pricing: prices are FLAT and TAX-FREE. This system does not apply VAT,
 * sales tax, or any percentage-based tax split. The figure the customer is
 * quoted is the figure charged, the figure stored, and the figure printed on
 * every receipt — with no division and no tax inflation.
 *
 * (History: this module previously derived a 12% VAT split from an inclusive
 * total, and before that added 12% on top of it. Both models are gone. A tax
 * line that is computed differently in two places is a tax line that will
 * eventually disagree with itself; removing it removes that class of defect.)
 * ============================================================================
 */

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round(n * 100) / 100;

const formatPeso = (value) =>
  `₱${num(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Derive the money picture for a booking + payment. Mirrors the frontend
 * resolver exactly; see that file for the full rationale.
 */
const resolveTransactionAmounts = (booking = {}, payment = null) => {
  const bookingTotal = num(booking?.total_amount);
  const totalDue = num(payment?.booking_total_at_payment) || bookingTotal;
  const declared = num(payment?.amount);
  const detectedNet = num(payment?.detected_amount);
  const recordedNet = num(payment?.net_credit);
  const transferFee = Math.max(0, num(payment?.transfer_fee));

  const hasVerified = detectedNet > 0 || recordedNet > 0;
  const netReceived = detectedNet > 0 ? detectedNet : (recordedNet > 0 ? recordedNet : declared);

  // OCR is authoritative once it has produced a value. A submitted
  // downpayment can remain in `amount` after OCR reads the actual receipt, so
  // falling back to the declared value here makes the email under-report what
  // was paid. With no fee, gross and OCR net are the same figure.
  const grossPaid = detectedNet > 0
    ? round2(detectedNet + transferFee)
    : declared > 0 ? declared : netReceived;

  const creditApplied = Math.max(0, num(payment?.credit_applied));
  const netApplied = round2(netReceived + creditApplied);

  // The transfer fee was not received by the shop. Keep it in grossPaid for
  // customer-facing detail, but only apply netReceived to the booking ledger.
  const creditedToBooking = netApplied;

  const excessCredit = Math.max(0, round2(creditedToBooking - totalDue));
  const remainingBalance = Math.max(0, round2(totalDue - creditedToBooking));

  return {
    bookingTotal,
    totalDue,
    grossPaid: round2(grossPaid),
    netReceived: round2(netReceived),
    declared: round2(declared),
    transferFee,
    netApplied,
    creditedToBooking,
    creditApplied,
    excessCredit,
    remainingBalance,
    verified: hasVerified,
    // FLAT, TAX-FREE PRICING. The total due IS the price — there is no tax to
    // extract, so no `vatIncluded` / `vatExclusiveSales` are returned. Any
    // consumer that still reads those keys will get `undefined` rather than a
    // plausible-looking number, which is deliberate: a silently-zero tax line is
    // harder to notice than a missing one.
  };
};

/**
 * THE OCR-vs-RECORDED RECONCILIATION.
 *
 * `payment.amount` is what the CLIENT declared when submitting. `detected_amount`
 * is what the AI actually read off the receipt. When these disagree, the receipt
 * email and the booking ledger were quoting different numbers to the same
 * customer — the defect being fixed here.
 *
 * We do NOT silently "correct" one to the other: the AI can misread a receipt,
 * and the customer can mistype a number. We DETECT the disagreement, report it,
 * and let the recorded (declared) figure stand as the source of truth so the
 * system's own numbers stay self-consistent. Surfacing the divergence is what
 * lets an admin resolve it before money is confirmed.
 *
 * @param {number} tolerance  Absolute peso tolerance. Below this, a difference
 *                            is rounding noise, not a real mismatch.
 * @returns {{matches:boolean, declared:number, detected:number, difference:number, severity:'ok'|'minor'|'major'}}
 */
const reconcileOcrAmounts = (declaredAmount, detectedAmount, tolerance = 1) => {
  const declared = round2(num(declaredAmount));
  const detected = round2(num(detectedAmount));

  // No OCR figure means nothing to reconcile — treat as matching.
  if (detected <= 0) {
    return { matches: true, declared, detected: 0, difference: 0, severity: 'ok' };
  }

  const difference = round2(Math.abs(declared - detected));

  if (difference <= Math.max(0, num(tolerance))) {
    return { matches: true, declared, detected, difference, severity: 'ok' };
  }

  // A discrepancy larger than 25% of the detected figure, or over ₱500, is
  // material enough to justify holding the payment for manual verification.
  const severity = (detected > 0 && difference / detected > 0.25) || difference > 500
    ? 'major'
    : 'minor';

  return { matches: false, declared, detected, difference, severity };
};

module.exports = {
  resolveTransactionAmounts,
  reconcileOcrAmounts,
  formatPeso,
  round2,
};