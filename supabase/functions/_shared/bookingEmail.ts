/**
 * supabase/functions/_shared/bookingEmail.js
 * ============================================================================
 * ONE module that renders every customer booking email.
 *
 * WHY THIS EXISTS
 * ---------------
 * Booking emails were assembled in three separate places (client eventEngine,
 * the send-status-email edge function, and backend/server.js), each with its own
 * idea of the money and its own copy of the templates. That is how one payment
 * produced two emails quoting two different amounts.
 *
 * THE LIFECYCLE (industry-standard, and what this module encodes)
 * ---------------------------------------------------------------
 * A booking has TWO customer-facing money/lifecycle touchpoints:
 *
 *   1. `booking_created` — fired ONCE, when the booking is submitted.
 *      Carries the booking summary AND the payment-as-submitted (amount, OCR
 *      reference, what we read off the receipt). The money is NOT yet verified,
 *      so the copy says so explicitly. This replaces the old pair of
 *      "Payment Submitted" + "Booking is now SCHEDULED" mails.
 *
 *   2. `booking_confirmed` — fired ONCE when an admin verifies the payment.
 *      THIS is where the official receipt (PDF) belongs. A receipt must only be
 *      issued against VERIFIED money; attaching it to the submission mail would
 *      issue an official document for a payment that might still be rejected.
 *
 * Every other status change (in progress, completed, released, cancelled) is a
 * plain status mail — one per status change, never with a receipt.
 *
 * Duplicate suppression is enforced by a DB ledger (booking_email_deliveries),
 * not by client bookkeeping, so a retry or a double-submit cannot double-send.
 *
 * OCR FIELDS
 * ----------
 * The OCR result is read from `bookings.ocr_metadata` — NOT from the payment row.
 * persist_ocr_result() writes the rich metadata to the BOOKING and only the
 * amount/reference to the payment:
 *
 *     update payments set detected_amount = ..., detected_ref = ...;
 *     update bookings set payment_status = ..., ocr_metadata = ...;
 *
 * The keys come from backend/services/ocrService.js:
 *   amount | grossAmount | transferFee | referenceNumber | timestamp |
 *   isValidReceipt | recipient | description
 * The previously-shipped emails read NONE of these, which is why they could not
 * show what the OCR actually found.
 * ============================================================================
 */

// ── Data shapes ───────────────────────────────────────────────────────────
//
// These mirror the columns the lifecycle function actually selects. They are
// deliberately structural (not generated DB types) so the renderer stays
// decoupled from the schema while still being type-safe at every call site —
// the row shapes are exactly what the `select()` in booking-lifecycle returns.

export interface BookingLike {
  id?: string
  customer_id?: string | null
  customer_name?: string | null
  customer_email?: string | null
  total_amount?: number | string | null
  status?: string | null
  payment_status?: string | null
  payment_method?: string | null
  start_datetime?: string | null
  /** Rich OCR result; persist_ocr_result() writes this onto the BOOKING. */
  ocr_metadata?: Record<string, unknown> | null
}

export interface PaymentLike {
  id?: string
  /** What the CLIENT declared. Last-resort fallback only. */
  amount?: number | string | null
  /** What the OCR actually read (the net the shop received). */
  detected_amount?: number | string | null
  /** Recomputed net credit from the ledger logic. */
  net_credit?: number | string | null
  transfer_fee?: number | string | null
  credit_applied?: number | string | null
  /** Enum in the DB; typed as string because it crosses serialisation. */
  status?: string | null
  method?: string | null
  reference_number?: string | null
  detected_ref?: string | null
  created_at?: string | null
}

export interface OcrDetails {
  /** Did we manage to read a receipt at all? */
  verified: boolean
  detectedNet: number
  gross: number
  transferFee: number
  reference: string | null
  sender: string | null
  transactionAt: string | null
  description: string | null
  amountMatched: boolean
  isDuplicate: boolean
  auditedAt: string | null
}

// ── Formatting ──────────────────────────────────────────────────────────────

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const formatPeso = (value: unknown): string =>
  `₱${num(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const formatDateTime = (value: unknown): string => {
  if (!value) return 'your scheduled time';
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
};

// ── Money model (mirrors frontend/src/utils/paymentAmounts.js) ──────────────

/**
 * The TRANSFER FEE is not a shortfall: the customer paid it, the bank kept it
 * in transit. Crediting the booking with the gross keeps a cross-bank transfer
 * from reading as short-paid.
 *
 * VAT: this is the Philippines, so VAT is 12% and the published price is
 * VAT-INCLUSIVE (VATable base = gross / 1.12; VAT = gross - base). This module
 * previously divided by 112 as though the rate were 12 of 112 (10.71%), which
 * understated the VAT on a document whose whole purpose is tax correctness:
 * ₱250 split as ₱26.79 VAT / ₱223.21 base instead of ₱26.79 vs ₱30.00 / ₱220.00.
 */
export const VAT_RATE = 0.12;

/** Quietly correct VAT against a VAT-inclusive (gross) amount. */
const vatOf = (vatInclusiveAmount: number) => {
  const base = round2(vatInclusiveAmount / (1 + VAT_RATE));
  return { base, vat: round2(vatInclusiveAmount - base) };
};

export const resolveAmounts = (booking: BookingLike = {}, payment: PaymentLike | null = null) => {
  const bookingTotal = num(booking?.total_amount);
  const declared = num(payment?.amount);
  const detectedNet = num(payment?.detected_amount);
  const recordedNet = num(payment?.net_credit);
  const transferFee = Math.max(0, num(payment?.transfer_fee));

  // Prefer what was actually READ (OCR) over what the client DECLARED.
  const netReceived = detectedNet > 0 ? detectedNet : (recordedNet > 0 ? recordedNet : declared);
  // OCR is authoritative once it has produced a value. The submitted amount
  // may still be the downpayment figure even when the receipt shows a larger
  // payment, so never let it replace a valid OCR result.
  const grossPaid = detectedNet > 0
    ? round2(detectedNet + transferFee)
    : (declared > 0 ? declared : netReceived)

  const creditApplied = Math.max(0, num(payment?.credit_applied));
  const netApplied = round2(netReceived + creditApplied);
  const creditedToBooking = round2(netApplied + transferFee);
  const vat = vatOf(bookingTotal);

  return {
    bookingTotal,
    totalDue: bookingTotal,
    grossPaid: round2(grossPaid),
    netReceived: round2(netReceived),
    transferFee,
    creditApplied,
    netApplied,
    creditedToBooking,
    remainingBalance: Math.max(0, round2(bookingTotal - creditedToBooking)),
    excessCredit: Math.max(0, round2(creditedToBooking - bookingTotal)),
    vatIncluded: vat.vat,
    vatExclusiveSales: vat.base,
    paymentStatus: String(payment?.status || '').toUpperCase(),
    paymentMethod: payment?.method || booking?.payment_method || '—',
    hasPayment: Boolean(payment),
  };
};

// ── OCR detail extraction ───────────────────────────────────────────────────

/**
 * Pull the OCR findings into a stable shape. The keys mirror ocrService.js so
 * the email finally shows what was actually read off the receipt: the reference
 * number, the sender, the transaction timestamp and the detected amount.
 *
 * The metadata lives on the BOOKING (see persist_ocr_result); the payment row
 * carries only the detected amount, reference and fee. Both are accepted here so
 * the resolver is correct regardless of which row the caller had to hand.
 */
export const extractOcrDetails = (booking?: BookingLike | null, payment?: PaymentLike | null): OcrDetails => {
  const meta: Record<string, unknown> = (booking?.ocr_metadata && typeof booking.ocr_metadata === 'object')
    ? booking.ocr_metadata as Record<string, unknown>
    : (payment && (payment as Record<string, unknown>).ocr_metadata && typeof (payment as Record<string, unknown>).ocr_metadata === 'object')
      ? (payment as Record<string, unknown>).ocr_metadata as Record<string, unknown>
      : {};

  const detectedNet = num(payment?.detected_amount) || num(meta.amount);
  const gross = num(meta.grossAmount) || (detectedNet > 0 ? detectedNet + num(payment?.transfer_fee) : 0);

  const reference = payment?.detected_ref || meta.referenceNumber || meta.referenceNo || null;
  const referenceValue = reference && String(reference).toUpperCase() !== 'MANUAL_AUDIT_PENDING'
    ? String(reference)
    : null;

  const rawTimestamp = meta.timestamp || meta.date || null;
  let transactionAt: string | null = null;
  if (rawTimestamp) {
    const parsed = new Date(String(rawTimestamp));
    transactionAt = Number.isNaN(parsed.getTime())
      ? String(rawTimestamp)
      : parsed.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }

  return {
    verified: Boolean(meta.isValidReceipt) || detectedNet > 0,
    detectedNet: round2(detectedNet),
    gross: round2(gross),
    transferFee: Math.max(0, num(payment?.transfer_fee) || num(meta.transferFee)),
    reference: referenceValue,
    sender: meta.recipient ? String(meta.recipient) : null,
    transactionAt,
    description: meta.description ? String(meta.description) : null,
    amountMatched: meta.isAmountMatch === true,
    isDuplicate: meta.isDuplicate === true,
    auditedAt: meta.auditedAt ? String(meta.auditedAt) : null,
  };
};

// ── Shared chrome ───────────────────────────────────────────────────────────

const shell = (title: string, inner: string): string => `
  <div style="font-family:'Segoe UI',Tahoma,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;color:#111827;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:#a91b18;padding:22px;text-align:center;color:#ffffff;">
      <h1 style="margin:0;font-size:23px;letter-spacing:2px;">SPEEDWAY AUTOXMOTO</h1>
    </div>
    <div style="padding:30px;">
      <h2 style="color:#a91b18;margin:0 0 18px;">${escapeHtml(title)}</h2>
      ${inner}
    </div>
    <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#6b7280;">
      &copy; ${new Date().getFullYear()} Speedway AutoxMoto. All Rights Reserved.
    </div>
  </div>`;

const lifecycleSteps = ['SUBMITTED', 'CONFIRMED', 'IN PROGRESS', 'COMPLETED', 'RELEASED'];

const renderLifecycle = (statusKey: string): string => {
  const normalized = statusKey === 'ONGOING' ? 'IN PROGRESS'
    : statusKey === 'SCHEDULED' ? 'SUBMITTED'
      : statusKey.replaceAll('_', ' ');
  const activeIndex = lifecycleSteps.indexOf(normalized);
  const isException = ['CANCELLED', 'FLAGGED NOSHOW'].includes(normalized);

  return `<div style="margin:28px 0;padding:18px 10px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;">
    <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:16px;">Booking lifecycle</div>
    <table role="presentation" style="width:100%;border-collapse:collapse;"><tr>
      ${lifecycleSteps.map((step, index) => {
        const isActive = index === activeIndex;
        const isPast = activeIndex >= 0 && index < activeIndex;
        const color = isException && index === 0 ? '#dc2626' : (isActive || isPast ? '#e61e2a' : '#cbd5e1');
        return `<td style="width:${100 / lifecycleSteps.length}%;text-align:center;vertical-align:top;">
          <div style="margin:0 auto 8px;width:18px;height:18px;line-height:18px;border-radius:50%;background:${color};color:#fff;font-size:11px;font-weight:700;">${isPast || isActive ? '&#10003;' : ''}</div>
          <div style="font-size:10px;line-height:13px;color:${isActive ? '#111827' : '#6b7280'};font-weight:${isActive ? '700' : '400'};">${step}</div>
        </td>`;
      }).join('')}
    </tr></table>
    ${isException ? `<div style="margin-top:12px;text-align:center;color:#dc2626;font-size:12px;font-weight:700;">${escapeHtml(normalized)}</div>` : ''}
  </div>`;
};

const bookingTable = (booking: BookingLike, appointmentDate: string, amounts: ReturnType<typeof resolveAmounts>): string => `
  <table role="presentation" style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;">
    <tr><td style="padding:12px 14px;color:#6b7280;font-size:13px;">Booking ID</td><td style="padding:12px 14px;text-align:right;font-weight:700;font-size:13px;">${escapeHtml(String(booking.id || '').slice(0, 8).toUpperCase())}</td></tr>
    <tr><td style="padding:12px 14px;color:#6b7280;font-size:13px;">Booking Total</td><td style="padding:12px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.totalDue)}</td></tr>
    <tr><td style="padding:12px 14px;color:#6b7280;font-size:13px;">Scheduled Time</td><td style="padding:12px 14px;text-align:right;font-weight:700;font-size:13px;">${escapeHtml(appointmentDate)}</td></tr>
  </table>`;

/**
 * The PAYMENT block. `includeOcr` is true for the submission mail (where the
 * point is "here is what we read off your receipt") and false for the
 * confirmation mail (where the money is already verified and the receipt PDF
 * carries the detail instead).
 */
const paymentBlock = (
  amounts: ReturnType<typeof resolveAmounts>,
  ocr: OcrDetails | null,
  { includeOcr = true }: { includeOcr?: boolean } = {}
): string => {
  if (!amounts.hasPayment) return '';

  const rows: string[] = [];
  rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Amount Paid</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.grossPaid)}</td></tr>`);

  if (amounts.transferFee > 0) {
    rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Transfer Fee (absorbed)</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.transferFee)}</td></tr>`);
    rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Amount Received</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.netReceived)}</td></tr>`);
  }

  if (amounts.creditApplied > 0) {
    rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Credit Applied</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.creditApplied)}</td></tr>`);
  }

  if (amounts.excessCredit > 0) {
    rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Recorded as Excess Credit</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.excessCredit)}</td></tr>`);
  }

  rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">${amounts.remainingBalance > 0 ? 'Balance Still Due' : 'Booking Total'}</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.remainingBalance > 0 ? amounts.remainingBalance : amounts.totalDue)}</td></tr>`);

  // ── What the OCR actually read off the receipt ──────────────────────────
  const ocrRows: string[] = [];
  if (includeOcr && ocr) {
    if (ocr.reference) ocrRows.push(`<tr><td style="padding:8px 14px;color:#6b7280;font-size:12px;">Reference No.</td><td style="padding:8px 14px;text-align:right;font-weight:600;font-size:12px;">${escapeHtml(ocr.reference)}</td></tr>`);
    if (ocr.sender) ocrRows.push(`<tr><td style="padding:8px 14px;color:#6b7280;font-size:12px;">Sender</td><td style="padding:8px 14px;text-align:right;font-weight:600;font-size:12px;">${escapeHtml(ocr.sender)}</td></tr>`);
    if (ocr.transactionAt) ocrRows.push(`<tr><td style="padding:8px 14px;color:#6b7280;font-size:12px;">Transaction Date</td><td style="padding:8px 14px;text-align:right;font-weight:600;font-size:12px;">${escapeHtml(ocr.transactionAt)}</td></tr>`);
    if (ocr.detectedNet > 0) ocrRows.push(`<tr><td style="padding:8px 14px;color:#6b7280;font-size:12px;">Amount Read From Receipt</td><td style="padding:8px 14px;text-align:right;font-weight:600;font-size:12px;">${formatPeso(ocr.detectedNet)}</td></tr>`);
  }

  const ocrSection = ocrRows.length
    ? `<div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:18px 0 8px;">Receipt Details (auto-read)</div>
       <table role="presentation" style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;">${ocrRows.join('')}</table>`
    : (includeOcr && amounts.hasPayment
      ? `<div style="margin-top:12px;padding:10px 12px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;font-size:12px;color:#6b7280;">We could not automatically read the receipt details. Our team will verify your payment manually.</div>`
      : '');

  const statusNote = amounts.paymentStatus === 'FOR_VERIFICATION'
    ? `<div style="margin-top:14px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #f59e0b;border-radius:6px;font-size:12px;color:#92400e;">Your payment is queued for verification. We will send your official receipt once it is approved.</div>`
    : amounts.paymentStatus === 'PAID'
      ? `<div style="margin-top:14px;padding:10px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-left:4px solid #10b981;border-radius:6px;font-size:12px;color:#065f46;">Payment verified. A detailed itemised receipt is attached to this email.</div>`
      : '';

  return `
    <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:24px 0 10px;">Payment</div>
    <table role="presentation" style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;">${rows.join('')}</table>
    ${ocrSection}
    ${statusNote}`;
};

const ctaButton = (label: string): string =>
  `<div style="margin-top:28px;text-align:center;"><a href="https://speedway-autoxmoto.com/portal" style="background:#a91b18;color:#ffffff;padding:13px 26px;text-decoration:none;border-radius:5px;font-weight:700;display:inline-block;">${escapeHtml(label)}</a></div>`;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * The SUBMISSION email: booking + payment as submitted (OCR detail included),
 * explicitly NOT yet verified.
 */
export const buildBookingCreatedEmail = ({ booking, payment, customerName }: {
  booking: BookingLike
  payment?: PaymentLike | null
  customerName?: string | null
}) => {
  const amounts = resolveAmounts(booking, payment);
  const ocr = extractOcrDetails(booking, payment);
  const appointmentDate = formatDateTime(booking?.start_datetime);

  const body = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">${escapeHtml(
      `${SITE_INTRO} Your booking has been received and your slot is reserved.`
    )}</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${paymentBlock(amounts, ocr)}
    ${renderLifecycle(booking?.status || 'SCHEDULED')}
    ${ctaButton('VIEW IN PORTAL')}`;

  const subject = amounts.hasPayment
    ? `Speedway: Booking #${String(booking?.id || '').slice(0, 8).toUpperCase()} received — ${formatPeso(amounts.grossPaid)} awaiting verification`
    : `Speedway: Booking #${String(booking?.id || '').slice(0, 8).toUpperCase()} received`;

  return { subject, html: shell('Booking Received', body), amounts, ocr };
};

/**
 * The CONFIRMATION email. This is where the OFFICIAL RECEIPT (PDF) belongs: a
 * receipt may only be issued against VERIFIED money, so it must not ride on the
 * submission mail where the payment could still be rejected.
 */
export const buildBookingConfirmedEmail = ({ booking, payment, customerName, hasReceipt }: {
  booking: BookingLike
  payment?: PaymentLike | null
  customerName?: string | null
  hasReceipt?: boolean
}) => {
  const amounts = resolveAmounts(booking, payment);
  const appointmentDate = formatDateTime(booking?.start_datetime);

  const body = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">Your payment has been verified and your appointment is now confirmed. Your official receipt is ${hasReceipt ? 'attached to this email' : 'available in your portal'}.</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${paymentBlock(amounts, null, { includeOcr: false })}
    ${renderLifecycle('CONFIRMED')}
    ${ctaButton('VIEW RECEIPT IN PORTAL')}`;

  return {
    subject: `Speedway: Booking #${String(booking?.id || '').slice(0, 8).toUpperCase()} confirmed${amounts.hasPayment ? ` — ${formatPeso(amounts.creditedToBooking)} received` : ''}`,
    html: shell('Booking Confirmed', body),
    amounts,
  };
};

const SITE_INTRO = 'Thank you for choosing Speedway AutoxMoto Detail Studio.';

const STATUS_COPY: Record<string, string> = {
  IN_PROGRESS: "Great news! We've started detailing your vehicle.",
  ONGOING: "Great news! We've started detailing your vehicle.",
  COMPLETED: 'Your ride is ready for pickup! Check your portal for the final receipt.',
  RELEASED: 'Your vehicle has been released. Thank you for choosing Speedway. Please come again for your future Auto x Moto needs!',
  CANCELLED: 'Your booking has been cancelled. Please check your portal for details regarding your refund or rescheduling.',
  FLAGGED_NOSHOW: 'We missed you! Your slot has expired. Visit the Refund Hub for details.',
};

/** A plain status-change email: one per status change, never with a receipt. */
export const buildStatusEmail = ({ booking, payment, customerName, newStatus, remarks }: {
  booking: BookingLike
  payment?: PaymentLike | null
  customerName?: string | null
  newStatus?: string | null
  remarks?: string | null
}): { subject: string; html: string; amounts: ReturnType<typeof resolveAmounts> } => {
  const statusKey = String(newStatus || '').toUpperCase();
  const amounts = resolveAmounts(booking, payment);
  const appointmentDate = formatDateTime(booking?.start_datetime);

  const body: string = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">${escapeHtml(STATUS_COPY[statusKey] || `Your booking status has been updated to ${newStatus}.`)}</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${renderLifecycle(statusKey)}
    ${remarks ? `<p style="margin-top:15px;padding:10px;background:#f8fafc;border-left:4px solid #a91b18;"><strong>Note:</strong> ${escapeHtml(remarks)}</p>` : ''}
    ${ctaButton('VIEW IN PORTAL')}`;

  return {
    subject: `Speedway Update: Booking #${String(booking?.id || '').slice(0, 8).toUpperCase()} is now ${statusKey}`,
    html: shell('Booking Status Update', body),
    amounts,
  };
};

/** The reminder mail (scheduled) — unchanged content, shared chrome. */
export const buildReminderEmail = ({ booking, payment, customerName }: {
  booking: BookingLike
  payment?: PaymentLike | null
  customerName?: string | null
}) => {
  const amounts = resolveAmounts(booking, payment);
  const appointmentDate = formatDateTime(booking?.start_datetime);

  const body = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">This is a reminder that your confirmed appointment is scheduled for ${escapeHtml(appointmentDate)}. Please arrive on time. If service has not started within one hour after your scheduled time, the booking will be flagged as a No-Show.</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${renderLifecycle(booking?.status || 'CONFIRMED')}
    ${ctaButton('VIEW IN PORTAL')}`;

  return {
    subject: 'Reminder: Your confirmed Speedway appointment is in 1 hour',
    html: shell('Appointment Reminder', body),
    amounts,
  };
};

/**
 * In-app notification copy, kept beside the emails so the bell and the inbox
 * never describe the same event differently.
 */
export const notificationCopyFor = (
  statusKey: string,
  bookingRef: string,
  amounts?: { hasPayment?: boolean; grossPaid?: number } | null
) => {
  const map: Record<string, { title: string; message: string; type: string }> = {
    SCHEDULED: {
      title: 'Booking Received',
      message: amounts?.hasPayment
        ? `Your booking #${bookingRef} was submitted with a payment of ${formatPeso(amounts.grossPaid)}. Awaiting verification.`
        : `Your booking #${bookingRef} has been submitted and is awaiting confirmation.`,
      type: 'BOOKING_CREATED',
    },
    CONFIRMED: { title: 'Booking Confirmed', message: `Your appointment #${bookingRef} has been confirmed. Your receipt is in your portal.`, type: 'BOOKING_CONFIRMED' },
    IN_PROGRESS: { title: 'Service Started', message: `Work has started on booking #${bookingRef}.`, type: 'SERVICE_STARTED' },
    ONGOING: { title: 'Service Started', message: `Work has started on booking #${bookingRef}.`, type: 'SERVICE_STARTED' },
    COMPLETED: { title: 'Service Completed', message: `Service for booking #${bookingRef} is complete and ready for pickup.`, type: 'SERVICE_COMPLETED' },
    RELEASED: { title: 'Booking Released', message: `Booking #${bookingRef} has been released.`, type: 'BOOKING_RELEASED' },
    CANCELLED: { title: 'Booking Cancelled', message: `Booking #${bookingRef} was cancelled.`, type: 'BOOKING_CANCELLED' },
    FLAGGED_NOSHOW: { title: 'Booking Flagged as No-Show', message: `Booking #${bookingRef} was flagged after the arrival window expired.`, type: 'BOOKING_FLAGGED_NOSHOW' },
  };
  return map[statusKey] || null;
};

export default {
  resolveAmounts,
  extractOcrDetails,
  buildBookingCreatedEmail,
  buildBookingConfirmedEmail,
  buildStatusEmail,
  buildReminderEmail,
  notificationCopyFor,
  formatPeso,
};