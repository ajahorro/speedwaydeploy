/**
 * booking-lifecycle
 * ============================================================================
 * The SINGLE dispatch point for every customer booking email.
 *
 * RUNTIME NOTE: this module runs on the Supabase Edge Runtime (Deno), which is
 * where `Deno` and `serve` come from. The reference below pulls in the local
 * ambient typings for those globals so an editor pass type-checks this file
 * instead of reporting "Cannot find name 'Deno'" for correct code. It is
 * type-only and has zero effect at runtime.
 */
/// <reference path="../_shared/deno-types.d.ts" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend'
import {
  resolveAmounts,
  extractOcrDetails,
  buildBookingCreatedEmail,
  buildBookingConfirmedEmail,
  buildStatusEmail,
  buildReminderEmail,
  notificationCopyFor,
  formatPeso,
  type BookingLike,
  type PaymentLike,
  type OcrDetails,
} from '../_shared/bookingEmail.ts'

/** A Resend attachment: base64 `content` plus a filename. */
interface EmailAttachment {
  content: string
  filename: string
}

/** A line item on the receipt PDF. */
interface ReceiptItem {
  vehicle?: string
  service?: string
  qty?: number
  unitPrice?: number
  lineTotal?: number
}

/** The shape returned by the embedded selects in this function. */
interface BookingRow extends BookingLike {
  profiles?: { full_name?: string | null; email?: string | null } | null
  vehicles?: Array<{
    brand?: string | null
    model?: string | null
    plate_number?: string | null
    services?: Array<{ service_name?: string | null; price?: number | string | null }> | null
  }> | null
  payments?: PaymentLike[] | null
}

/**
 * booking-lifecycle
 * ============================================================================
 * The SINGLE dispatch point for every customer booking email.
 *
 * WHY ONE FUNCTION
 * ----------------
 * Emails were previously sent from three places (client eventEngine, the
 * backend receipt endpoint, and the send-status-email function), each with its
 * own templates and its own money maths. That is how a single booking produced
 * two emails quoting two different amounts.
 *
 * LIFECYCLE (see _shared/bookingEmail.ts for the full rationale)
 * ---------------------------------------------------------------
 *   event: 'booking_created'   -> booking summary + payment-as-submitted,
 *                                 including what the OCR read off the receipt.
 *                                 No receipt PDF: the money is not verified yet.
 *   event: 'booking_confirmed' -> confirmation + the OFFICIAL RECEIPT (PDF).
 *                                 This is the only event that carries a receipt,
 *                                 because a receipt must only be issued against
 *                                 VERIFIED money.
 *   event: <status>            -> a plain status mail, one per status change.
 *
 * EXACTLY-ONCE
 * ------------
 * Every send is claimed against public.booking_email_deliveries. A duplicate
 * call is refused by the DATABASE, so a retry, a double-tap, or two concurrent
 * callers cannot double-send. If the provider rejects the message the claim is
 * released, so a genuine failure still gets retried.
 *
 * BODY
 * ----
 *   { bookingId, event, remarks?, reminder?, eventKey? }
 * `event` accepts a lifecycle keyword ('booking_created', 'booking_confirmed')
 * or a raw status ('scheduled', 'confirmed', 'in_progress', ...).
 * ============================================================================
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const resend = new Resend(Deno.env.get('RESEND_API_KEY'))
const resendFrom = Deno.env.get('RESEND_FROM') || 'Comar Garage <notifications@speedway-autoxmoto.xyz>'
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

// ── Receipt PDF ─────────────────────────────────────────────────────────────
// A minimal, dependency-free PDF builder (the same technique the Node backend
// uses). Kept inline so the edge function has no build step and cannot fail on
// a missing native module.
const escapePdfText = (v: unknown): string => String(v ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

const buildReceiptPdf = ({
  receiptNumber,
  customerName,
  bookingReference,
  issuedAt,
  paymentMethod,
  items,
  amounts,
  ocr,
}: {
  receiptNumber?: string | null
  customerName?: string | null
  bookingReference?: string | null
  issuedAt?: string | null
  paymentMethod?: string | null
  items: ReceiptItem[]
  amounts: ReturnType<typeof resolveAmounts>
  ocr: OcrDetails | null
}): string => {
  const dateString = issuedAt ? new Date(issuedAt).toLocaleString() : new Date().toLocaleString()

  const lines: string[] = [
    'COMAR GARAGE',
    'AutoxMoto Detail Studio',
    'OFFICIAL RECEIPT',
    '',
    `Receipt No.: ${receiptNumber || 'AUTO'}`,
    `Issued: ${dateString}`,
    `Booking Reference: ${bookingReference || 'N/A'}`,
    `Payment Method: ${paymentMethod || 'Digital / Online Payment'}`,
    `Customer: ${customerName || 'Customer'}`,
    '',
    'Vehicle / Service                          Qty   Unit Price   Line Total',
    ...items.map((item) => {
      const label = String(item.vehicle || 'Vehicle Unit').substring(0, 26)
      const service = String(item.service || 'Service').substring(0, 20)
      const unit = Number(item.unitPrice ?? item.lineTotal ?? 0)
      return `${label} ${service} ${item.qty ?? 1} ${formatPeso(unit)} ${formatPeso(unit)}`
    }),
    '',
    'PAYMENT',
    ...(ocr?.reference ? [`Reference No.: ${ocr.reference}`] : []),
    ...(ocr?.transactionAt ? [`Transaction Date: ${ocr.transactionAt}`] : []),
    `Amount Paid: ${formatPeso(amounts.grossPaid)}`,
    ...(amounts.transferFee > 0 ? [`Transfer Fee (absorbed): ${formatPeso(amounts.transferFee)}`] : []),
    ...(amounts.transferFee > 0 ? [`Amount Received: ${formatPeso(amounts.netReceived)}`] : []),
    ...(amounts.creditApplied > 0 ? [`Credit Applied: -${formatPeso(amounts.creditApplied)}`] : []),
    ...(amounts.excessCredit > 0 ? [`Recorded as Excess Credit: ${formatPeso(amounts.excessCredit)}`] : []),
    `Booking Total: ${formatPeso(amounts.totalDue)}`,
    ...(amounts.remainingBalance > 0 ? [`Balance Still Due: ${formatPeso(amounts.remainingBalance)}`] : []),
    // VAT is INCLUDED in the published price and broken out for compliance only.
    `VAT (12%, included): ${formatPeso(amounts.vatIncluded)}`,
    `Net of VAT: ${formatPeso(amounts.vatExclusiveSales)}`,
    '',
    'Payment verified. This receipt is valid for tax and audit purposes.',
  ]

  const content = lines
    .map((line, index) => `BT\n/F1 11 Tf\n72 ${760 - index * 18} Td\n(${escapePdfText(line)}) Tj\nET`)
    .join('\n')

  let pdf = '%PDF-1.4\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
  ]

  const offsets: number[] = [0]
  objects.forEach((obj, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`
  })

  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n` })
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  // Base64 for the Resend attachment payload.
  const bytes = new TextEncoder().encode(pdf)
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary)
}

const canonicalEvent = (raw: string): string => {
  const key = String(raw || '').toUpperCase()
  if (key === 'BOOKING_CREATED' || key === 'SCHEDULED' || key === 'PENDING') return 'booking_created'
  if (key === 'BOOKING_CONFIRMED' || key === 'CONFIRMED') return 'booking_confirmed'
  if (key === 'IN_PROGRESS' || key === 'ONGOING') return 'booking_in_progress'
  if (key === 'COMPLETED') return 'booking_completed'
  if (key === 'RELEASED') return 'booking_released'
  if (key === 'CANCELLED') return 'booking_cancelled'
  if (key === 'FLAGGED_NOSHOW') return 'booking_flagged_noshow'
  return String(raw || 'unknown').toLowerCase()
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // ── Authorization ─────────────────────────────────────────────────────────
  //
  // SECURITY POSTURE (and an honest note on what this is):
  //
  // This function is deployed `--no-verify-jwt`, so the platform does NOT
  // authenticate callers for us. The previous guard was:
  //
  //     if (!authHeader && !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) reject
  //
  // which is an AND — it only rejected when the header was missing AND the
  // env var was missing. Any request carrying any header passed. That is not
  // a guard.
  //
  // An attempt to require an exact service-role match was then MEASURED and
  // rejected: comparing the header against `Bearer ${Deno.env.get(...)}`
  // returned 401 for EVERY caller, including a valid service-role JWT (verified
  // across five auth shapes with scripts/diagnose-guard.mjs). Whatever the
  // platform does to the Authorization header before the function sees it, that
  // comparison is not a usable signal here, so it is deliberately not used.
  //
  // What is enforced instead: a caller must present a Bearer credential. That
  // stops anonymous and cross-origin drive-by calls. It does NOT prove the
  // caller is privileged — a logged-in customer holds a valid token too.
  //
  // FOLLOW-UP REQUIRED: since the body carries `bookingId` and the function
  // uses the service role internally, a customer who can call this could ask
  // it to mail ANOTHER customer's booking details. The correct fix is to
  // resolve the caller from the token and authorize per booking:
  //     admin  -> any booking
  //     customer -> only bookings where bookings.customer_id = auth.uid()
  // That needs the end-user JWT context plumbed in (not the service key), and
  // is tracked as the next change to this function.
  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders })
  }

  try {
    const payload: {
      bookingId?: string
      event?: string
      newStatus?: string
      remarks?: string
      reminder?: boolean
      eventKey?: string
    } = await req.json()

    const { bookingId, event, newStatus, remarks, eventKey } = payload
    const reminder: boolean = payload.reminder === true

    if (!bookingId) throw new Error('bookingId is required')
    const requested = event || newStatus || 'booking_created'
    const canonical = reminder ? 'booking_reminder' : canonicalEvent(requested)
    const lifecycleEvent = eventKey || canonical

    // ── Fetch everything, including the OCR result ──────────────────────────
    const { data: booking, error: bError } = await supabase
      .from('bookings')
      .select(`
        id, customer_id, customer_name, customer_email, contact_number,
        total_amount, status, payment_status, payment_method, start_datetime, notes,
        ocr_metadata,
        profiles:profiles!bookings_customer_id_fkey ( full_name, email ),
        vehicles:booking_vehicles!booking_vehicles_booking_id_fkey (
          brand, model, plate_number,
          services:booking_vehicle_services!booking_vehicle_id ( service_name, price )
        ),
        payments:payments!payments_booking_id_fkey (
          id, amount, detected_amount, net_credit, transfer_fee, credit_applied,
          status, method, reference_number, detected_ref, created_at
        )
      `)
      .eq('id', bookingId)
      .single()

    if (bError || !booking) throw new Error(`Booking not found: ${bError?.message || 'no row returned'}`)

    // The embedded select above returns exactly this shape.
    const row = booking as unknown as BookingRow

    const customer = row.profiles
    const email = customer?.email || row.customer_email
    const customerName = customer?.full_name || row.customer_name || 'Valued Customer'
    if (!email) throw new Error('No customer email found for this booking.')

    // Newest payment is the one this event concerns.
    const payments: PaymentLike[] = Array.isArray(row.payments) ? row.payments : []
    const payment: PaymentLike | null = payments.length
      ? [...payments].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0]
      : null

    const amounts = resolveAmounts(row, payment)
    // OCR metadata lives on the BOOKING (persist_ocr_result writes it there);
    // the payment row only carries the detected amount, reference and fee.
    const ocr = extractOcrDetails(row, payment)

    const items: ReceiptItem[] = (row.vehicles || []).flatMap((v) =>
      (v.services || []).map((s) => ({
        vehicle: `${v.brand || ''} ${v.model || ''}`.trim() || 'Vehicle Unit',
        service: s.service_name || 'Service',
        qty: 1,
        unitPrice: Number(s.price || 0),
      }))
    )

    const bookingRef = String(bookingId).slice(0, 8).toUpperCase()

    // ── Render the right email for this event ───────────────────────────────
    let subject = ''
    let html = ''
    let attachments: EmailAttachment[] = []

    const isConfirmed = canonical === 'booking_confirmed'

    if (isConfirmed) {
      const receiptNumber = payment?.reference_number || payment?.detected_ref || `INV-${bookingRef}`
      // A receipt is only attached when the money is actually settled. A partial
      // payment is confirmed as a booking but must not receive a full receipt.
      const isSettled = amounts.remainingBalance <= 0 || amounts.paymentStatus === 'PAID'
      const receiptPdf = isSettled
        ? buildReceiptPdf({
            receiptNumber,
            customerName,
            bookingReference: bookingRef,
            issuedAt: payment?.created_at,
            paymentMethod: amounts.paymentMethod,
            items,
            amounts,
            ocr,
          })
        : null

      if (receiptPdf) {
        attachments = [{
          content: receiptPdf,
          filename: `Receipt-${String(receiptNumber).replace(/\s+/g, '-').toUpperCase()}.pdf`,
        }]
      }

      const built = buildBookingConfirmedEmail({ booking: row, payment, customerName, hasReceipt: Boolean(receiptPdf) })
      subject = built.subject
      html = built.html
    } else if (canonical === 'booking_created') {
      const built = buildBookingCreatedEmail({ booking: row, payment, customerName })
      subject = built.subject
      html = built.html
    } else if (canonical === 'booking_reminder') {
      const built = buildReminderEmail({ booking: row, payment, customerName })
      subject = built.subject
      html = built.html
    } else {
      const built = buildStatusEmail({ booking: row, payment, customerName, newStatus: requested, remarks })
      subject = built.subject
      html = built.html
    }

    // ── Claim exactly-once BEFORE sending ───────────────────────────────────
    // Claiming first is what makes duplicates impossible. Releasing the claim on
    // failure (below) keeps a genuine failure retryable.
    const { data: claimData, error: claimError }: {
      data: { claimed?: boolean; reason?: string; sent_at?: string } | null
      error: { message: string } | null
    } = await supabase.rpc('claim_booking_email', {
      p_booking_id: bookingId,
      p_event: lifecycleEvent,
      p_recipient: email,
      p_sent_by: 'booking-lifecycle',
    })

    if (claimError) throw new Error(`Could not claim the email delivery: ${claimError.message}`)

    const claim = claimData

    if (!claim?.claimed) {
      return new Response(JSON.stringify({
        ok: true,
        skipped: true,
        reason: claim?.reason || 'ALREADY_SENT',
        event: lifecycleEvent,
        alreadySentAt: claim?.sent_at,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })
    }

    // ── In-app notification (kept in lockstep with the email) ───────────────
    const statusKey = canonical === 'booking_created' ? 'SCHEDULED' : canonical === 'booking_confirmed' ? 'CONFIRMED' : String(requested).toUpperCase()
    const copy = notificationCopyFor(statusKey, bookingRef, amounts)

    if (copy && row.customer_id) {
      const { error: notificationError } = await supabase.from('notifications').insert({
        user_id: row.customer_id,
        booking_id: bookingId,
        action_url: `/customer/bookings/${bookingId}`,
        title: reminder ? 'Appointment Reminder' : copy.title,
        message: reminder ? `Your appointment #${bookingRef} is scheduled in 1 hour.` : copy.message,
        notification_type: reminder ? 'BOOKING_REMINDER' : copy.type,
        is_read: false,
      })
      if (notificationError) {
        console.error('Notification persistence failed before email delivery:', notificationError)
      }
    }

    // ── Send ────────────────────────────────────────────────────────────────
    const { data: sent, error: sendError } = await resend.emails.send({
      from: resendFrom,
      to: [email],
      subject,
      html,
      ...(attachments.length ? { attachments } : {}),
    })

    if (sendError) {
      // Release the claim so this mail can be retried — otherwise a transient
      // provider failure would permanently silence the customer.
      await supabase.rpc('release_booking_email_claim', { p_booking_id: bookingId, p_event: lifecycleEvent })
      throw sendError
    }

    await supabase.rpc('record_booking_email_result', {
      p_booking_id: bookingId,
      p_event: lifecycleEvent,
      p_resend_id: sent?.id ?? null,
    })

    return new Response(JSON.stringify({
      ok: true,
      event: lifecycleEvent,
      to: email,
      subject,
      attachments: attachments.length,
      resendId: sent?.id ?? null,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[booking-lifecycle]', message)
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})