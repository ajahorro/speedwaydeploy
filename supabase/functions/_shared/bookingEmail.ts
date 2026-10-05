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
 * Major status changes (completed, cancelled, and no-show) are plain status
 * emails — intermediate changes such as in-progress and release are kept out of
 * the inbox. Confirmation is its own event, and reminders are sent separately.
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
 * The keys come from the OCR parse (backend/services/receiptTextParser.js on the
 * server, mirrored by frontend/src/utils/receiptOcr.js in the browser):
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
  /** The booking-details link for this recipient (login, or registration for a walk-in). */
  portal_url?: string | null
  customer_id?: string | null
  customer_name?: string | null
  customer_first_name?: string | null
  customer_last_name?: string | null
  customer_email?: string | null
  contact_number?: string | null
  total_amount?: number | string | null
  discount_amount_snapshot?: number | string | null
  promo_name_snapshot?: string | null
  status?: string | null
  payment_status?: string | null
  payment_method?: string | null
  start_datetime?: string | null
  staff_id?: string | null
  technician_name?: string | null
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
  recipientAccount: string | null
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

// ── Money model: the database ledger ────────────────────────────────────────

/**
 * Row from booking_financial_ledger(booking_id) / public.booking_ledger_v.
 * Every amount in a customer email is read from here, so emails always match
 * the portal, the admin screens and the financial reports.
 */
export type LedgerLike = Record<string, unknown>

/**
 * Email amounts, mapped from the ledger (no payment-row arithmetic here).
 *
 *   "submitted" figures include receipts still awaiting verification (used by
 *   the booking-created mail); "verified" figures count accepted money only.
 *   Transfer fees are shown to the customer but never credited to the booking
 *   (net-received rule, shared with public.payment_net_received()).
 *
 * PRICING: flat and tax-free; the booking total is the amount due.
 */
export const resolveAmounts = (
  ledger: LedgerLike | null | undefined,
  payment: PaymentLike | null = null
) => {
  const row = ledger || {};
  const hasPending = Boolean(row.has_pending_verification);
  const verifiedPaid = num(row.verified_paid);
  const submittedGross = num(row.submitted_gross_paid);

  return {
    bookingTotal: num(row.expected_amount),
    totalDue: num(row.expected_amount),
    grossPaid: round2(submittedGross),
    netReceived: round2(num(row.submitted_net_received)),
    transferFee: round2(num(row.submitted_transfer_fee)),
    creditApplied: round2(num(row.credit_applied)),
    creditedToBooking: round2(num(row.submitted_net_received)),
    remainingBalance: round2(num(row.submitted_balance_due)),
    excessCredit: round2(num(row.submitted_excess)),
    verifiedGrossPaid: round2(num(row.verified_gross_paid)),
    verifiedNetReceived: round2(verifiedPaid),
    verifiedRemainingBalance: round2(num(row.service_balance_due)),
    verifiedExcessCredit: round2(num(row.excess_amount)),
    fullySettled: Boolean(row.fully_settled),
    paymentStatus: hasPending
      ? 'FOR_VERIFICATION'
      : verifiedPaid > 0 ? 'PAID' : String(payment?.status || '').toUpperCase(),
    paymentMethod: payment?.method || '—',
    hasPayment: submittedGross > 0 || hasPending,
  };
};

// ── OCR detail extraction ───────────────────────────────────────────────────

/**
 * Pull the OCR findings into a stable shape. The keys mirror the OCR parse
 * (backend/services/receiptTextParser.js server-side, mirrored by
 * frontend/src/utils/receiptOcr.js in the browser) so the email finally shows
 * what was actually read off the receipt: the reference
 * number, receiving account, transaction timestamp and detected amount.
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
    recipientAccount: meta.recipient ? String(meta.recipient) : null,
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
      <h1 style="margin:0;font-size:23px;letter-spacing:2px;">COMAR GARAGE</h1>
    </div>
    <div style="padding:30px;">
      <h2 style="color:#a91b18;margin:0 0 18px;">${escapeHtml(title)}</h2>
      ${inner}
    </div>
    <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#6b7280;">
      &copy; ${new Date().getFullYear()} Comar Garage. All Rights Reserved.
    </div>
  </div>`;

const lifecycleSteps = ['SCHEDULED', 'CONFIRMED', 'IN PROGRESS', 'COMPLETED', 'RELEASED'];

const renderLifecycle = (statusKey: string): string => {
  const rawStatus = String(statusKey || '').toUpperCase().replaceAll('_', ' ');
  const normalized = rawStatus === 'ONGOING' ? 'IN PROGRESS'
    : rawStatus === 'SUBMITTED' ? 'SCHEDULED'
      : rawStatus;
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
    ${booking.technician_name ? `<tr><td style="padding:12px 14px;color:#6b7280;font-size:13px;">Assigned Technician</td><td style="padding:12px 14px;text-align:right;font-weight:700;font-size:13px;">${escapeHtml(booking.technician_name)}</td></tr>` : ''}
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
  { includeOcr = true, receiptAttached = false }: { includeOcr?: boolean; receiptAttached?: boolean } = {}
): string => {
  if (!amounts.hasPayment) return '';

  const rows: string[] = [];
  rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Amount Paid</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.grossPaid)}</td></tr>`);

  if (amounts.transferFee > 0) {
    rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Transfer Fee (charged by your bank)</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.transferFee)}</td></tr>`);
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
    if (ocr.recipientAccount) ocrRows.push(`<tr><td style="padding:8px 14px;color:#6b7280;font-size:12px;">Recipient Account</td><td style="padding:8px 14px;text-align:right;font-weight:600;font-size:12px;">${escapeHtml(ocr.recipientAccount)}</td></tr>`);
    if (ocr.transactionAt) ocrRows.push(`<tr><td style="padding:8px 14px;color:#6b7280;font-size:12px;">Transaction Date</td><td style="padding:8px 14px;text-align:right;font-weight:600;font-size:12px;">${escapeHtml(ocr.transactionAt)}</td></tr>`);
    if (ocr.detectedNet > 0) ocrRows.push(`<tr><td style="padding:8px 14px;color:#6b7280;font-size:12px;">Amount Read From Receipt</td><td style="padding:8px 14px;text-align:right;font-weight:600;font-size:12px;">${formatPeso(ocr.detectedNet)}</td></tr>`);
  }

  const ocrSection = ocrRows.length
    ? `<div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:18px 0 8px;">Receipt Details (auto-read)</div>
       <table role="presentation" style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;">${ocrRows.join('')}</table>`
    : (includeOcr && amounts.hasPayment && amounts.paymentStatus === 'FOR_VERIFICATION'
      ? `<div style="margin-top:12px;padding:10px 12px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;font-size:12px;color:#6b7280;">We could not automatically read the receipt details. Our team will verify your payment manually.</div>`
      : '');

  const statusNote = amounts.paymentStatus === 'FOR_VERIFICATION'
    ? `<div style="margin-top:14px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #f59e0b;border-radius:6px;font-size:12px;color:#92400e;">Your payment is queued for verification. We will send your official receipt once it is approved.</div>`
    : amounts.paymentStatus === 'PAID'
      ? `<div style="margin-top:14px;padding:10px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-left:4px solid #10b981;border-radius:6px;font-size:12px;color:#065f46;">${receiptAttached ? 'Payment verified. A detailed itemised receipt is attached to this email.' : 'Payment verified. Your itemised receipt will be available after the booking balance is paid.'}</div>`
      : '';

  return `
    <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:24px 0 10px;">Payment</div>
    <table role="presentation" style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;">${rows.join('')}</table>
    ${ocrSection}
    ${statusNote}`;
};

/** The public address of the website (set SITE_URL on the function to change it). */
export const siteUrl = (): string => {
  const configured = (globalThis as { Deno?: { env: { get(key: string): string | undefined } } })
    .Deno?.env.get('SITE_URL')
  return String(configured || 'https://comargarage.com').replace(/\/+$/, '')
}

/** Where a signed-out visitor lands after signing in: this booking's details. */
export const bookingDetailsPath = (bookingId: string): string => `/customer/bookings/${bookingId}`

const BOOKING_DETAILS_LABEL = 'VIEW BOOKING DETAILS'

const portalUrlFor = (booking: BookingLike): { url: string; label: string } => {
  const next = booking.id ? bookingDetailsPath(booking.id) : '/customer'
  // The lifecycle function decides per recipient: login for someone who has an
  // account, registration (pre-filled from a 7-day invite) for a walk-in.
  if (booking.portal_url) {
    return { url: booking.portal_url, label: BOOKING_DETAILS_LABEL }
  }
  // Fallback: sign in, then land on the booking.
  return {
    url: `${siteUrl()}/login?next=${encodeURIComponent(next)}`,
    label: BOOKING_DETAILS_LABEL,
  }
}

const ctaButton = (booking: BookingLike, _label?: string): string => {
  const portal = portalUrlFor(booking)
  return `<div style="margin-top:28px;text-align:center;"><a href="${escapeHtml(portal.url)}" style="background:#a91b18;color:#ffffff;padding:13px 26px;text-decoration:none;border-radius:5px;font-weight:700;display:inline-block;">${escapeHtml(portal.label)}</a></div>`
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * The SUBMISSION email: booking + payment as submitted (OCR detail included),
 * explicitly NOT yet verified.
 */
export const buildBookingCreatedEmail = ({ booking, payment, ledger, customerName }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
}) => {
  const amounts = resolveAmounts(ledger, payment);
  const ocr = extractOcrDetails(booking, payment);
  const appointmentDate = formatDateTime(booking?.start_datetime);

  const body = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">${escapeHtml(
      `${SITE_INTRO} Your appointment has been scheduled and your time slot is reserved.`
    )}</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${paymentBlock(amounts, ocr)}
    ${renderLifecycle(booking?.status || 'SCHEDULED')}
    ${ctaButton(booking, 'VIEW BOOKING DETAILS')}`;

  const paymentState = amounts.paymentStatus === 'PAID' ? 'payment verified' : 'payment awaiting verification';
  const subject = amounts.hasPayment
    ? `Comar Garage: Booking #${String(booking?.id || '').slice(0, 8).toUpperCase()} scheduled — ${formatPeso(amounts.grossPaid)} ${paymentState}`
    : `Comar Garage: Booking #${String(booking?.id || '').slice(0, 8).toUpperCase()} scheduled`;

  return { subject, html: shell('Booking Scheduled', body), amounts, ocr };
};

/**
 * The CONFIRMATION email. This is where the OFFICIAL RECEIPT (PDF) belongs: a
 * receipt may only be issued against VERIFIED money, so it must not ride on the
 * submission mail where the payment could still be rejected.
 */
export const buildBookingConfirmedEmail = ({ booking, payment, ledger, customerName, hasReceipt }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
  hasReceipt?: boolean
}) => {
  const amounts = resolveAmounts(ledger, payment);
  const appointmentDate = formatDateTime(booking?.start_datetime);

  const body = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">Your payment has been verified and your appointment is now confirmed. ${hasReceipt ? 'Your itemised receipt is attached to this email.' : 'Your payment details are available in your portal; an official receipt will be issued when the booking balance is paid.'}</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${paymentBlock(amounts, null, { includeOcr: false, receiptAttached: hasReceipt })}
    ${renderLifecycle('CONFIRMED')}
    ${ctaButton(booking, 'VIEW BOOKING DETAILS')}`;

  return {
    subject: `Comar Garage: Booking #${String(booking?.id || '').slice(0, 8).toUpperCase()} confirmed${amounts.hasPayment ? ` — ${formatPeso(amounts.creditedToBooking)} received` : ''}`,
    html: shell('Booking Confirmed', body),
    amounts,
  };
};

const SITE_INTRO = 'Thank you for choosing Comar Garage.';

/**
 * PAYMENT RECEIVED: sent once per verified payment (claim key
 * payment_verified:<payment id>) with that payment's transaction receipt.
 */
export const buildPaymentVerifiedEmail = ({ booking, payment, ledger, customerName, hasReceipt, hasStatement }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
  hasReceipt?: boolean
  hasStatement?: boolean
}) => {
  const amounts = resolveAmounts(ledger, payment);
  const appointmentDate = formatDateTime(booking?.start_datetime);
  const attachmentsNote = [
    hasReceipt ? 'the official receipt for this payment' : null,
    hasStatement ? 'your Statement of Account (the booking is now fully paid)' : null,
  ].filter(Boolean).join(' and ');

  const body = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">We have verified your payment.${attachmentsNote ? ` Attached is ${escapeHtml(attachmentsNote)}.` : ''}</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${paymentBlock(amounts, null, { includeOcr: false, receiptAttached: Boolean(hasReceipt) })}
    ${ctaButton(booking, 'VIEW BOOKING DETAILS')}`;

  return {
    subject: `Comar Garage: Payment received for booking #${String(booking?.id || '').slice(0, 8).toUpperCase()}${amounts.fullySettled ? ' — fully paid' : ''}`,
    html: shell('Payment Received', body),
    amounts,
  };
};

/**
 * FULLY PAID: sent once per booking (claim key booking_settled) when the ledger
 * first reports fully_settled, carrying the cumulative Statement of Account.
 */
export const buildBookingSettledEmail = ({ booking, ledger, customerName }: {
  booking: BookingLike
  ledger?: LedgerLike | null
  customerName?: string | null
}) => {
  const amounts = resolveAmounts(ledger, null);
  const appointmentDate = formatDateTime(booking?.start_datetime);
  const body = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">Your booking is now fully paid. Your Statement of Account, listing every payment and refund, is attached.</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${ctaButton(booking, 'VIEW BOOKING DETAILS')}`;
  return {
    subject: `Comar Garage: Booking #${String(booking?.id || '').slice(0, 8).toUpperCase()} fully paid — Statement of Account`,
    html: shell('Booking Fully Paid', body),
    amounts,
  };
};

const STATUS_COPY: Record<string, string> = {
  IN_PROGRESS: "Great news! We've started detailing your vehicle.",
  ONGOING: "Great news! We've started detailing your vehicle.",
  COMPLETED: 'Your ride is ready for pickup! Check your portal for the final receipt.',
  RELEASED: 'Your vehicle has been released. Thank you for choosing Comar Garage. Please come again for your future detailing needs!',
  CANCELLED: 'Your booking has been cancelled. Please check your portal for details regarding your refund or rescheduling.',
  FLAGGED_NOSHOW: 'We missed you! Your slot has expired. Visit the Refund Hub for details.',
};

/** A plain major status-change email; the lifecycle dispatcher may attach a settled receipt. */
export const buildStatusEmail = ({ booking, payment, ledger, customerName, newStatus, remarks }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
  newStatus?: string | null
  remarks?: string | null
}): { subject: string; html: string; amounts: ReturnType<typeof resolveAmounts> } => {
  const statusKey = String(newStatus || '').toUpperCase();
  const amounts = resolveAmounts(ledger, payment);
  const appointmentDate = formatDateTime(booking?.start_datetime);

  const body: string = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">${escapeHtml(STATUS_COPY[statusKey] || `Your booking status has been updated to ${newStatus}.`)}</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${paymentBlock(amounts, extractOcrDetails(booking, payment))}
    ${renderLifecycle(statusKey)}
    ${remarks ? `<p style="margin-top:15px;padding:10px;background:#f8fafc;border-left:4px solid #a91b18;"><strong>Note:</strong> ${escapeHtml(remarks)}</p>` : ''}
    ${ctaButton(booking, 'VIEW BOOKING DETAILS')}`;

  return {
    subject: `Comar Garage Update: Booking #${String(booking?.id || '').slice(0, 8).toUpperCase()} is now ${statusKey}`,
    html: shell('Booking Status Update', body),
    amounts,
  };
};

/** The reminder mail (scheduled) — unchanged content, shared chrome. */
export const buildReminderEmail = ({ booking, payment, ledger, customerName }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
}) => {
  const amounts = resolveAmounts(ledger, payment);
  const appointmentDate = formatDateTime(booking?.start_datetime);

  const body = `
    <p style="font-size:16px;">Hi ${escapeHtml(customerName)},</p>
    <p style="font-size:15px;line-height:1.6;">This is a reminder that your confirmed appointment is scheduled for ${escapeHtml(appointmentDate)}. Please arrive on time. If service has not started within one hour after your scheduled time, the booking will be flagged as a No-Show.</p>
    ${bookingTable(booking, appointmentDate, amounts)}
    ${renderLifecycle(booking?.status || 'CONFIRMED')}
    ${ctaButton(booking, 'VIEW BOOKING DETAILS')}`;

  return {
    subject: 'Reminder: Your confirmed Comar Garage appointment is in 1 hour',
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
      title: 'Booking Scheduled',
      message: amounts?.hasPayment
        ? `Your appointment #${bookingRef} is scheduled. Payment of ${formatPeso(amounts.grossPaid)} was submitted and is awaiting verification.`
        : `Your appointment #${bookingRef} is scheduled and is awaiting confirmation.`,
      type: 'BOOKING_CREATED',
    },
    CONFIRMED: { title: 'Booking Confirmed', message: `Your appointment #${bookingRef} has been confirmed. Your receipt is in your portal.`, type: 'BOOKING_CONFIRMED' },
    PAYMENT_VERIFIED: { title: 'Payment Received', message: `We verified your payment for booking #${bookingRef}. Your receipt is in your portal.`, type: 'PAYMENT_APPROVED' },
    BOOKING_SETTLED: { title: 'Booking Fully Paid', message: `Booking #${bookingRef} is fully paid. Your Statement of Account is in your portal.`, type: 'BOOKING_SETTLED' },
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
  buildPaymentVerifiedEmail,
  buildBookingSettledEmail,
  buildStatusEmail,
  buildReminderEmail,
  notificationCopyFor,
  formatPeso,
};