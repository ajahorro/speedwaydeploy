/**
 * paymentAmounts.js
 * ============================================================================
 * ONE place that decides "how much money is this payment, actually?"
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * A payment row carries several different money figures and they are NOT
 * interchangeable. Treating them as one figure produced real, customer-visible
 * defects:
 *
 *   * The receipt email showed `payment.amount || booking.total_amount` and
 *     then ADDED 12% VAT on top — so a customer who paid ₱250 for a ₱250
 *     booking was emailed a "Total Amount Due" of ₱280 in VAT-inclusive shop
 *     whose prices already include VAT.
 *
 *   * The lifecycle email showed only `booking.total_amount`, so it disagreed
 *     with the receipt whenever the booking had a promo, a partial
 *     (downpayment) plan, or when the OCR read a net figure that differed from
 *     the amount the customer declared.
 *
 *   * OCR returns the NET amount received by the shop (gross minus any transfer
 *     / convenience fee). The customer, however, paid the GROSS. Quoting the
 *     net back to them reads as "your payment is short" when it is not.
 *
 * THE MODEL
 * ---------
 *   gross (what the customer actually sent)  = detected_amount + transfer_fee
 *                                              (or the declared amount when no
 *                                               OCR figure exists)
 *   net   (what the shop actually received)  = detected_amount
 *   due   (what the booking costs)           = booking.total_amount
 *
 * `amount` on the payments row is what the CLIENT declared, not what was
 * verified. It is used only as the last-resort fallback, never as the headline
 * figure once a verified/OCR value exists.
 *
 * Returning ONE structured object (rather than a bare number) is deliberate:
 * it makes "which amount did you mean?" a required decision at every call site
 * instead of an easy silent mistake.
 * ============================================================================
 */

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Peso formatter shared by every email/receipt surface, so the same figure
 * never renders two different ways in the same inbox.
 */
export const formatPeso = (value) =>
  `₱${num(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Derive the full money picture for a booking + (optional) payment.
 *
 * @param {object} booking  bookings row — needs total_amount.
 * @param {object} [payment] payments row. Optional: a booking email with no
 *                           payment yet must still be renderable.
 * @returns {{
 *   currency: string,
 *   bookingTotal: number,   // what the whole service costs
 *   grossPaid: number,      // what the customer actually sent
 *   netReceived: number,    // what the shop actually received (OCR truth)
 *   transferFee: number,    // bank/transfer fee absorbed in the middle
 *   netApplied: number,     // how much of netReceived counts toward the booking
 *   creditApplied: number,  // excess credit consumed from the ledger
 *   excessCredit: number,   // surplus banked as excess credit
 *   remainingBalance: number, // still owed after this payment
 *   verified: boolean,      // is netReceived trusted (OCR/verified) or declared
 *   paymentStatus: string,
 *   paymentMethod: string,
 *   parts: Array<{label:string, amount:number}>, // ready for rendering
 * }}
 */
export const resolveTransactionAmounts = (booking = {}, payment = null) => {
  const bookingTotal = num(booking?.total_amount);
  const totalDue = num(payment?.booking_total_at_payment) || bookingTotal;

  // What the customer declared they sent. Last-resort fallback only.
  const declared = num(payment?.amount);

  // Verified/OCR figures. `detected_amount` is the NET the shop received.
  const detectedNet = num(payment?.detected_amount);
  const recordedNet = num(payment?.net_credit);
  const transferFee = Math.max(0, num(payment?.transfer_fee));

  // Which figure is the truth? Prefer a verified/OCR value; `net_credit` was
  // computed by this system's own ledger logic, so it outranks `amount`.
  const hasVerified = detectedNet > 0 || recordedNet > 0;
  const netReceived = detectedNet > 0 ? detectedNet : (recordedNet > 0 ? recordedNet : declared);

  // The customer paid the gross when a transfer fee was deducted in transit.
  const grossPaid = detectedNet > 0 && transferFee > 0
    ? round2(detectedNet + transferFee)
    : declared > 0 ? declared : netReceived;

  const creditApplied = Math.max(0, num(payment?.credit_applied));
  const netApplied = round2(netReceived + creditApplied);

  // The TRANSFER FEE IS NOT A SHORTFALL. The customer paid it — the bank just
  // kept it in transit. Crediting the booking with the gross (not the net) is
  // what stops a cross-bank/GoTyme transfer reading as short-paid and leaving a
  // phantom balance the customer already covered.
  const creditedToBooking = round2(netApplied + transferFee);

  const excessCredit = Math.max(0, round2(creditedToBooking - totalDue));
  const remainingBalance = Math.max(0, round2(totalDue - creditedToBooking));

  // Only show the "Amount Received / Transfer Fee" lines when they ADD
  // information. On a plain cash/GCash booking where gross == net, three rows
  // restating the same number is noise, not transparency.
  const parts = [{ label: 'Amount Paid', amount: grossPaid }];
  if (transferFee > 0) {
    parts.push({ label: 'Transfer Fee', amount: -transferFee });
    parts.push({ label: 'Amount Received', amount: netReceived });
  }
  if (creditApplied > 0) {
    parts.push({ label: 'Credit Applied', amount: creditApplied });
  }
  if (excessCredit > 0) {
    parts.push({ label: 'Recorded as Excess Credit', amount: excessCredit });
  }
  parts.push({
    label: remainingBalance > 0 ? 'Balance Still Due' : 'Total Amount Due',
    amount: totalDue,
  });

  void hasVerified; // retained for callers that want to branch on trust

  return {
    currency: 'PHP',
    bookingTotal,
    totalDue,
    grossPaid: round2(grossPaid),
    netReceived: round2(netReceived),
    transferFee,
    netApplied,
    creditedToBooking,
    creditApplied,
    excessCredit,
    remainingBalance,
    verified: hasVerified,
    paymentStatus: String(payment?.status || '').toUpperCase(),
    paymentMethod: payment?.method || booking?.payment_method || '—',
    parts,
  };
};

/**
 * A short, single-sentence money summary for the body of an email — so the
 * greeting paragraph and the line-item table can never disagree.
 */
export const buildAmountSentence = (amounts) => {
  if (!amounts) return '';
  if (amounts.remainingBalance > 0) {
    return `We have recorded ${formatPeso(amounts.creditedToBooking)} against this booking. A balance of ${formatPeso(amounts.remainingBalance)} remains.`;
  }
  if (amounts.excessCredit > 0) {
    return `We have received ${formatPeso(amounts.creditedToBooking)}, which is ${formatPeso(amounts.excessCredit)} more than the booking total. The surplus has been banked as credit on your account.`;
  }
  return `We have received ${formatPeso(amounts.creditedToBooking)} in full payment for this booking.`;
};

export default { resolveTransactionAmounts, buildAmountSentence, formatPeso };