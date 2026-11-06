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

import { renderEmail, formatDateTime as layoutDateTime } from './emailLayout.ts';

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

/** The public address of the website (set SITE_URL on the function to change it). */
export const siteUrl = (): string => {
  const configured = (globalThis as { Deno?: { env: { get(key: string): string | undefined } } })
    .Deno?.env.get('SITE_URL')
  return String(configured || 'https://comargarage.com').replace(/\/+$/, '')
}

/** Where a signed-out visitor lands after signing in: this booking's details. */
export const bookingDetailsPath = (bookingId: string): string => `/customer/bookings/${bookingId}`

const BOOKING_DETAILS_LABEL = 'View my booking'

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

// ── Shared chrome: the one layout every Comar Garage email uses ─────────────

type LayoutBlock = string | Record<string, unknown>;

/** Shop details for the footer (Business Hub › Business Profile). */
export interface ShopInfo {
  name?: string | null
  address?: string | null
  site?: string | null
  phone?: string | null
  email?: string | null
}

const MANILA = 'Asia/Manila';
const shortDate = (value: unknown): string => {
  if (!value) return '';
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-PH', { timeZone: MANILA, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
};
const shortTime = (value: unknown): string => {
  if (!value) return '';
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-PH', { timeZone: MANILA, hour: 'numeric', minute: '2-digit' }).format(d);
};
const refOf = (booking: BookingLike | null | undefined): string => String(booking?.id || '').slice(0, 8).toUpperCase();
const firstNameOf = (name: unknown): string => (/^valued customer$/i.test(String(name || '').trim()) ? '' : String(name || '').trim().split(/\s+/)[0] || '');
const greetingFor = (name: unknown): string => (firstNameOf(name) ? `Hi ${firstNameOf(name)},` : 'Hi,');

const shell = (o: {
  title: string
  preheader: string
  customerName?: string | null
  blocks: LayoutBlock[]
  booking: BookingLike
  shop?: ShopInfo | null
}): { html: string; text: string } => {
  const portal = portalUrlFor(o.booking);
  return renderEmail({
    title: o.title,
    preheader: o.preheader,
    greeting: greetingFor(o.customerName),
    blocks: o.blocks,
    cta: { label: 'View my booking', url: portal.url },
    reason: 'You get this email because you have a booking with Comar Garage.',
    shop: { ...(o.shop || {}), site: o.shop?.site || siteUrl() },
  });
};

/** Where the booking is: Booked, Confirmed, In progress, Ready, Released (none for cancelled or no-show). */
const STEP_INDEX: Record<string, number> = { SCHEDULED: 0, SUBMITTED: 0, PENDING: 0, CONFIRMED: 1, IN_PROGRESS: 2, ONGOING: 2, COMPLETED: 3, RELEASED: 4 };
const renderLifecycle = (statusKey: string): LayoutBlock | null => {
  const index = STEP_INDEX[String(statusKey || '').toUpperCase()];
  return index === undefined ? null : { type: 'steps', active: index };
};

const bookingTable = (booking: BookingLike, amounts: ReturnType<typeof resolveAmounts>): LayoutBlock => ({
  type: 'rows',
  title: 'Your booking',
  rows: [
    ['Booking no.', refOf(booking)],
    ['Date and time', layoutDateTime(booking?.start_datetime)],
    ['Technician', booking.technician_name || ''],
    ['Booking total', formatPeso(amounts.totalDue)],
  ],
});

/**
 * The PAYMENT blocks. `includeOcr` is true for the submission mail (where the point is "here is what we read off
 * your receipt") and false once the money is verified (the receipt PDF carries the detail instead).
 */
const paymentBlock = (
  amounts: ReturnType<typeof resolveAmounts>,
  ocr: OcrDetails | null,
  { includeOcr = true, receiptAttached = false }: { includeOcr?: boolean; receiptAttached?: boolean } = {}
): LayoutBlock[] => {
  if (!amounts.hasPayment) return [];
  const rows: string[][] = [];
  rows.push(['Amount paid', formatPeso(amounts.grossPaid)]);
  if (amounts.transferFee > 0) rows.push(['Amount received (after transfer fee)', formatPeso(amounts.netReceived)]);
  if (amounts.creditApplied > 0) rows.push(['Credit used', formatPeso(amounts.creditApplied)]);
  if (amounts.excessCredit > 0) rows.push(['Saved as credit for next time', formatPeso(amounts.excessCredit)]);
  rows.push(amounts.remainingBalance > 0 ? ['Balance to pay', formatPeso(amounts.remainingBalance)] : ['Balance to pay', formatPeso(0)]);

  const blocks: LayoutBlock[] = [{ type: 'rows', title: 'Payment', rows }];

  const ocrRows: string[][] = [];
  if (includeOcr && ocr) {
    if (ocr.reference) ocrRows.push(['Reference no.', ocr.reference]);
    if (ocr.transactionAt) ocrRows.push(['Paid on', ocr.transactionAt]);
    if (ocr.detectedNet > 0) ocrRows.push(['Amount on the receipt', formatPeso(ocr.detectedNet)]);
  }
  if (ocrRows.length) blocks.push({ type: 'rows', title: 'What we read from your receipt', rows: ocrRows });

  if (amounts.paymentStatus === 'FOR_VERIFICATION') {
    blocks.push({ type: 'notice', tone: 'warn', text: ocrRows.length || !includeOcr
      ? 'We are checking your payment. You will get an official receipt by email once it is approved.'
      : 'We could not read your receipt automatically, so a person will check it. You will get an official receipt once it is approved.' });
  } else if (amounts.paymentStatus === 'PAID') {
    blocks.push({ type: 'notice', tone: 'success', text: receiptAttached ? 'Payment verified. Your official receipt is attached as a PDF.' : 'Payment verified. Your official receipt is in your account.' });
  }
  return blocks;
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * The SUBMISSION email: booking + payment as submitted (OCR detail included), explicitly NOT yet verified.
 */
export const buildBookingCreatedEmail = ({ booking, payment, ledger, customerName, shop }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
  shop?: ShopInfo | null
}) => {
  const amounts = resolveAmounts(ledger, payment);
  const ocr = extractOcrDetails(booking, payment);
  const day = shortDate(booking?.start_datetime);
  const { html, text } = shell({
    title: amounts.hasPayment ? 'We got your booking and payment' : 'We got your booking',
    preheader: `${day ? `${day} at ${shortTime(booking?.start_datetime)}. ` : ''}${amounts.hasPayment ? 'We are checking your payment now.' : 'Your time slot is reserved.'}`,
    customerName,
    booking,
    shop,
    blocks: [
      `Thank you for booking with Comar Garage. Your time slot is reserved${amounts.hasPayment ? ' and we are checking your payment' : ''}.`,
      bookingTable(booking, amounts),
      ...paymentBlock(amounts, ocr),
      renderLifecycle(booking?.status || 'SCHEDULED'),
    ].filter(Boolean) as LayoutBlock[],
  });
  const subject = amounts.hasPayment
    ? `We got your booking and payment for ${day || 'your appointment'} (#${refOf(booking)})`
    : `We got your booking for ${day || 'your appointment'} (#${refOf(booking)})`;
  return { subject, html, text, amounts, ocr };
};

/**
 * The CONFIRMATION email. This is where the OFFICIAL RECEIPT (PDF) belongs: a receipt may only be issued against
 * VERIFIED money, so it must not ride on the submission mail where the payment could still be rejected.
 */
export const buildBookingConfirmedEmail = ({ booking, payment, ledger, customerName, hasReceipt, shop }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
  hasReceipt?: boolean
  shop?: ShopInfo | null
}) => {
  const amounts = resolveAmounts(ledger, payment);
  const day = shortDate(booking?.start_datetime);
  const { html, text } = shell({
    title: 'Your booking is confirmed',
    preheader: `See you on ${day || 'your appointment day'} at ${shortTime(booking?.start_datetime)}.`,
    customerName,
    booking,
    shop,
    blocks: [
      `We verified your payment and confirmed your appointment. ${hasReceipt ? 'Your official receipt is attached.' : 'Your payment details are in your account.'}`,
      bookingTable(booking, amounts),
      ...paymentBlock(amounts, null, { includeOcr: false, receiptAttached: hasReceipt }),
      renderLifecycle('CONFIRMED'),
      { type: 'small', text: 'Please arrive on time. If we cannot start within an hour of your booked time, the booking may be marked as a no-show.' },
    ].filter(Boolean) as LayoutBlock[],
  });
  return { subject: `Your booking on ${day || 'your appointment day'} is confirmed (#${refOf(booking)})`, html, text, amounts };
};

/**
 * PAYMENT RECEIVED: sent once per verified payment (claim key payment_verified:<payment id>) with that payment's
 * transaction receipt.
 */
export const buildPaymentVerifiedEmail = ({ booking, payment, ledger, customerName, hasReceipt, hasStatement, shop }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
  hasReceipt?: boolean
  hasStatement?: boolean
  shop?: ShopInfo | null
}) => {
  const amounts = resolveAmounts(ledger, payment);
  const attached = [hasReceipt ? 'the official receipt for this payment' : null, hasStatement ? 'your Statement of Account' : null].filter(Boolean).join(' and ');
  const { html, text } = shell({
    title: 'We received your payment',
    preheader: `${formatPeso(amounts.verifiedGrossPaid || amounts.grossPaid)} received for booking #${refOf(booking)}.`,
    customerName,
    booking,
    shop,
    blocks: [
      `We verified your payment for booking **#${refOf(booking)}**.${attached ? ` Attached is ${attached}.` : ''}`,
      bookingTable(booking, amounts),
      ...paymentBlock(amounts, null, { includeOcr: false, receiptAttached: Boolean(hasReceipt) }),
    ],
  });
  return { subject: `Payment received for booking #${refOf(booking)}${amounts.fullySettled ? ': fully paid' : ''}`, html, text, amounts };
};

/**
 * FULLY PAID: sent once per booking (claim key booking_settled) when the ledger first reports fully_settled,
 * carrying the cumulative Statement of Account.
 */
export const buildBookingSettledEmail = ({ booking, ledger, customerName, shop }: {
  booking: BookingLike
  ledger?: LedgerLike | null
  customerName?: string | null
  shop?: ShopInfo | null
}) => {
  const amounts = resolveAmounts(ledger, null);
  const { html, text } = shell({
    title: 'Your booking is fully paid',
    preheader: 'Your Statement of Account is attached.',
    customerName,
    booking,
    shop,
    blocks: [
      'Thank you. Your booking is fully paid. The attached Statement of Account lists every payment and refund for it.',
      bookingTable(booking, amounts),
    ],
  });
  return { subject: `Booking #${refOf(booking)} is fully paid`, html, text, amounts };
};

const STATUS_COPY: Record<string, string> = {
  IN_PROGRESS: 'Our team has started working on your vehicle. We will email you when it is ready.',
  ONGOING: 'Our team has started working on your vehicle. We will email you when it is ready.',
  COMPLETED: 'Your vehicle is ready for pickup. Please settle any balance at the shop when you collect it.',
  RELEASED: 'Your vehicle has been released. Thank you for choosing Comar Garage. We hope to see you again.',
  CANCELLED: 'Your booking has been cancelled. If you paid, your account shows whether a refund applies and how it is going.',
  FLAGGED_NOSHOW: 'We waited, but you did not arrive within an hour of your booked time, so the slot was released. Your account shows what happens to any payment.',
};
const STATUS_TITLE: Record<string, string> = {
  IN_PROGRESS: 'We started on your vehicle', ONGOING: 'We started on your vehicle', COMPLETED: 'Your vehicle is ready for pickup',
  RELEASED: 'Thank you for visiting', CANCELLED: 'Your booking was cancelled', FLAGGED_NOSHOW: 'We missed you',
};
const STATUS_SUBJECT: Record<string, (ref: string) => string> = {
  IN_PROGRESS: (ref) => `We started on your vehicle (#${ref})`,
  ONGOING: (ref) => `We started on your vehicle (#${ref})`,
  COMPLETED: (ref) => `Your vehicle is ready for pickup (#${ref})`,
  RELEASED: (ref) => `Thanks for visiting Comar Garage (#${ref})`,
  CANCELLED: (ref) => `Your booking #${ref} was cancelled`,
  FLAGGED_NOSHOW: (ref) => `We missed you at your appointment (#${ref})`,
};

/** A plain major status-change email; the lifecycle dispatcher may attach a settled receipt. */
export const buildStatusEmail = ({ booking, payment, ledger, customerName, newStatus, remarks, shop }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
  newStatus?: string | null
  remarks?: string | null
  shop?: ShopInfo | null
}): { subject: string; html: string; text: string; amounts: ReturnType<typeof resolveAmounts> } => {
  const statusKey = String(newStatus || '').toUpperCase();
  const amounts = resolveAmounts(ledger, payment);
  const readable = statusKey.toLowerCase().replaceAll('_', ' ');
  const { html, text } = shell({
    title: STATUS_TITLE[statusKey] || 'Booking update',
    preheader: STATUS_COPY[statusKey] || `Your booking is now ${readable}.`,
    customerName,
    booking,
    shop,
    blocks: [
      STATUS_COPY[statusKey] || `Your booking is now **${readable}**.`,
      remarks ? { type: 'notice', tone: 'info', title: 'Note from the shop', text: String(remarks) } : null,
      bookingTable(booking, amounts),
      ...paymentBlock(amounts, extractOcrDetails(booking, payment)),
      renderLifecycle(statusKey),
    ].filter(Boolean) as LayoutBlock[],
  });
  return { subject: (STATUS_SUBJECT[statusKey] || ((ref: string) => `Update on booking #${ref}`))(refOf(booking)), html, text, amounts };
};

/** The reminder mail (scheduled), one hour before a confirmed booking. */
export const buildReminderEmail = ({ booking, payment, ledger, customerName, shop }: {
  booking: BookingLike
  payment?: PaymentLike | null
  ledger?: LedgerLike | null
  customerName?: string | null
  shop?: ShopInfo | null
}) => {
  const amounts = resolveAmounts(ledger, payment);
  const time = shortTime(booking?.start_datetime);
  const { html, text } = shell({
    title: `See you at ${time || 'your booked time'}`,
    preheader: 'Your Comar Garage appointment is in about an hour.',
    customerName,
    booking,
    shop,
    blocks: [
      `A reminder that your appointment is at **${time || 'your booked time'}** today.`,
      bookingTable(booking, amounts),
      { type: 'small', text: 'If we cannot start within an hour of your booked time, the booking may be marked as a no-show. Running late? Message us in the app.' },
    ],
  });
  return { subject: `Reminder: your Comar Garage appointment is at ${time || 'your booked time'} today`, html, text, amounts };
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