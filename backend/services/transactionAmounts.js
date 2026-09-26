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
 * NOTE on VAT: this shop's published prices are VAT-INCLUSIVE (Philippines, 12%).
 * The receipt therefore shows "VAT (12% included)" broken OUT of the total rather
 * than added on top. Adding it on top is what inflated a ₱250 payment to a ₱280
 * "Total Amount Due".
 *
 *   VATable base = gross / 1.12      VAT = gross - base
 *
 * (An earlier version divided by 112, as though the rate were 12/112 = 10.71%,
 * which understated the VAT on an official tax document.)
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

  // The TRANSFER FEE IS NOT A SHORTFALL. The customer paid it — the bank simply
  // kept it in transit. Crediting the booking with the gross (not the net) is
  // what keeps a cross-bank/GoTyme transfer from reading as short-paid and
  // leaving a phantom balance the customer already covered. The shop absorbs
  // the fee; the booking is settled in full.
  const creditedToBooking = round2(netApplied + transferFee);

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
    // VAT is EXTRACTED from a VAT-inclusive total (base = gross / 1.12), never
    // added to it. Must match _shared/bookingEmail.ts and paymentAmounts.js.
    vatIncluded: round2(totalDue - round2(totalDue / 1.12)),
    vatExclusiveSales: round2(totalDue / 1.12),
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