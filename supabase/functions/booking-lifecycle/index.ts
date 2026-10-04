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
import { buildOfficialReceiptPdf } from '../_shared/officialReceiptPdf.ts'
import { buildStatementOfAccountPdf } from '../_shared/statementOfAccountPdf.ts'
import {
  resolveAmounts,
  buildBookingCreatedEmail,
  buildBookingConfirmedEmail,
  buildPaymentVerifiedEmail,
  buildBookingSettledEmail,
  buildStatusEmail,
  buildReminderEmail,
  notificationCopyFor,
  type BookingLike,
  type PaymentLike,
  type LedgerLike,
} from '../_shared/bookingEmail.ts'

/** A Resend attachment: base64 `content` plus a filename. */
interface EmailAttachment {
  content: string
  filename: string
}

/** A public.payment_ledger_v row (SQL-computed net_received / gross_paid). */
interface LedgerTransaction {
  payment_id: string
  status: string
  method?: string | null
  amount?: number | string | null
  net_received?: number | string | null
  gross_paid?: number | string | null
  transfer_fee?: number | string | null
  credit_applied?: number | string | null
  reference?: string | null
  created_at?: string | null
  verified_at?: string | null
  recognized_at?: string | null
  is_settled_credit?: boolean
  is_refund?: boolean
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
 *   event: <status>            -> a plain status mail only for approved major
 *                                 milestones (including start and release);
 *                                 intermediate status changes are skipped.
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
 * or a raw status. Booking creation, confirmation, start, completion, release,
 * cancellation, no-show, and reminders are emailed.
 * ============================================================================
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const resend = new Resend(Deno.env.get('RESEND_API_KEY'))
const resendFrom = Deno.env.get('RESEND_FROM') || 'Comar Garage <notifications@comargarage.com>'
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

const canonicalEvent = (raw: string): string => {
  const key = String(raw || '').toUpperCase()
  if (key === 'BOOKING_CREATED' || key === 'SCHEDULED' || key === 'PENDING') return 'booking_created'
  if (key === 'BOOKING_CONFIRMED' || key === 'CONFIRMED') return 'booking_confirmed'
  if (key === 'IN_PROGRESS' || key === 'ONGOING') return 'booking_in_progress'
  if (key === 'COMPLETED') return 'booking_completed'
  if (key === 'RELEASED') return 'booking_released'
  if (key === 'CANCELLED') return 'booking_cancelled'
  if (key === 'FLAGGED_NOSHOW') return 'booking_flagged_noshow'
  if (key === 'PAYMENT_VERIFIED') return 'payment_verified'
  if (key === 'BOOKING_SETTLED' || key === 'FULLY_SETTLED') return 'booking_settled'
  return String(raw || 'unknown').toLowerCase()
}

const EMAILABLE_LIFECYCLE_EVENTS = new Set([
  'booking_created',
  'booking_confirmed',
  'booking_in_progress',
  'booking_completed',
  'booking_released',
  'booking_cancelled',
  'booking_flagged_noshow',
  'booking_reminder',
  'payment_verified',
  'booking_settled',
])

/**
 * Who is calling. The function is deployed --no-verify-jwt, so it resolves the
 * caller itself instead of trusting the platform:
 *   - an end-user JWT  -> that user's profile (admin, or the booking's customer)
 *   - a service-role key (legacy JWT or sb_secret_ key) held by the backend ->
 *     proven by successfully calling an admin-only Auth endpoint with it
 * Comparing the header to SUPABASE_SERVICE_ROLE_KEY is not used: the backend
 * and the Edge runtime can hold different key formats for the same project.
 */
type Caller =
  | { kind: 'service' }
  | { kind: 'admin'; userId: string }
  | { kind: 'customer'; userId: string }
  | { kind: 'denied'; status: number; reason: string }

const resolveCaller = async (token: string): Promise<Caller> => {
  if (!token) return { kind: 'denied', status: 401, reason: 'Missing bearer credential' }

  const { data: userData } = await supabase.auth.getUser(token)
  const user = userData?.user
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_active')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile || profile.is_active === false) return { kind: 'denied', status: 403, reason: 'Inactive account' }
    const role = String(profile.role || '').toUpperCase()
    if (role === 'ADMIN') return { kind: 'admin', userId: user.id }
    if (role === 'CUSTOMER') return { kind: 'customer', userId: user.id }
    return { kind: 'denied', status: 403, reason: 'Not permitted to send booking email' }
  }

  const probe = createClient(Deno.env.get('SUPABASE_URL') ?? '', token, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: adminError } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (!adminError) return { kind: 'service' }

  return { kind: 'denied', status: 401, reason: 'Invalid credential' }
}

/** Events a customer may trigger for their own booking (submission/reschedule). */
const CUSTOMER_EVENTS = new Set(['booking_created'])

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // ── Authorization ─────────────────────────────────────────────────────────
  // Resolve the caller from the bearer credential (see resolveCaller):
  //   backend (service role) and active admins -> any booking and event
  //   a customer -> only their own booking, only the booking_created event,
  //                 and no custom eventKey/paymentId (so a customer cannot
  //                 re-key the exactly-once ledger to resend mail)
  //   anyone else -> refused
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const caller = await resolveCaller(bearer)
  if (caller.kind === 'denied') {
    return new Response(JSON.stringify({ error: caller.reason }), {
      status: caller.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const payload: {
      bookingId?: string
      event?: string
      newStatus?: string
      remarks?: string
      reminder?: boolean
      eventKey?: string
      paymentId?: string
    } = await req.json()

    const { bookingId, event, newStatus, remarks } = payload
    const isCustomer = caller.kind === 'customer'
    // Customers cannot choose claim keys, payments, remarks or reminders.
    const eventKey = isCustomer ? undefined : payload.eventKey
    const paymentId = isCustomer ? undefined : payload.paymentId
    const reminder: boolean = !isCustomer && payload.reminder === true

    if (!bookingId) throw new Error('bookingId is required')
    const requested = event || newStatus || 'booking_created'
    const canonical = reminder ? 'booking_reminder' : canonicalEvent(requested)

    if (isCustomer) {
      const { data: ownBooking } = await supabase
        .from('bookings')
        .select('customer_id')
        .eq('id', bookingId)
        .maybeSingle()
      if (!ownBooking || ownBooking.customer_id !== caller.userId || !CUSTOMER_EVENTS.has(canonical)) {
        return new Response(JSON.stringify({ error: 'Not permitted to send this booking email' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }
    if (canonical === 'payment_verified' && !paymentId) throw new Error('paymentId is required for payment_verified')
    const lifecycleEvent = eventKey
      || (canonical === 'payment_verified' ? `payment_verified:${paymentId}` : canonical)

    if (!EMAILABLE_LIFECYCLE_EVENTS.has(canonical)) {
      return new Response(JSON.stringify({
        ok: true,
        skipped: true,
        reason: 'EVENT_NOT_EMAILABLE',
        event: canonical,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })
    }

    // ── Fetch the booking, its ledger and its ledger transactions ───────────
    // Money comes ONLY from the database ledger (booking_ledger_v /
    // payment_ledger_v), so every email matches the portal and the reports.
    // `.maybeSingle()` so a missing booking is a clean 404.
    const { data: booking, error: bError } = await supabase
      .from('bookings')
      .select(`
        id, customer_id, customer_name, customer_first_name, customer_last_name,
        customer_email, contact_number,
        total_amount, discount_amount_snapshot, promo_name_snapshot,
        status, payment_status, payment_method, start_datetime, notes, staff_id,
        ocr_metadata,
        profiles:profiles!bookings_customer_id_fkey ( full_name, email ),
        vehicles:booking_vehicles!booking_vehicles_booking_id_fkey (
          brand, model, plate_number,
          services:booking_vehicle_services!booking_vehicle_id ( service_name, price )
        ),
        payments:payments!payments_booking_id_fkey (
          id, amount, detected_amount, verified_amount, transfer_fee, credit_applied,
          status, method, reference_number, detected_ref, created_at, verified_at
        )
      `)
      .eq('id', bookingId)
      .maybeSingle()

    if (bError) throw new Error(`Booking lookup failed: ${bError.message}`)
    if (!booking) throw new Error('Booking not found: no row returned')

    const [{ data: ledgerData, error: ledgerError }, { data: transactionRows, error: transactionsError }] = await Promise.all([
      supabase.rpc('booking_financial_ledger', { p_booking_id: bookingId }),
      supabase.from('payment_ledger_v').select('*').eq('booking_id', bookingId).order('created_at', { ascending: true }),
    ])
    if (ledgerError) throw new Error(`Ledger lookup failed: ${ledgerError.message}`)
    if (transactionsError) throw new Error(`Ledger transactions lookup failed: ${transactionsError.message}`)
    const ledger = (ledgerData || {}) as LedgerLike
    const transactions = (transactionRows || []) as LedgerTransaction[]

    // The embedded select above returns exactly this shape.
    const row = booking as unknown as BookingRow

    let technicianName: string | null = null
    if (row.staff_id) {
      const { data: staffProfile, error: staffError } = await supabase
        .from('profiles')
        .select('full_name, first_name, last_name')
        .eq('id', row.staff_id)
        .maybeSingle()
      if (staffError) console.warn('Assigned technician lookup failed:', staffError.message)
      technicianName = staffProfile?.full_name
        || `${staffProfile?.first_name || ''} ${staffProfile?.last_name || ''}`.trim()
        || null
    }
    const bookingForEmail = { ...row, technician_name: technicianName }

    const customer = row.profiles
    // Prioritize customer details entered directly on the booking (critical for walk-ins so admin details never leak)
    const email = row.customer_email || customer?.email
    const customerName = row.customer_name || customer?.full_name || 'Valued Customer'
    if (!email) throw new Error('No customer email found for this booking.')

    // The payment this event concerns: the explicit paymentId, else the newest.
    const payments: PaymentLike[] = Array.isArray(row.payments) ? row.payments : []
    const payment: PaymentLike | null = (paymentId && payments.find((item) => item.id === paymentId))
      || (payments.length
        ? [...payments].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0]
        : null)
    const verifiedTransaction: LedgerTransaction | null = paymentId
      ? (transactions.find((item) => item.payment_id === paymentId && item.status === 'PAID') || null)
      : null

    const amounts = resolveAmounts(ledger, payment)
    const bookingRef = String(bookingId).slice(0, 8).toUpperCase()
    const customerEmail = row.customer_email || customer?.email || ''
    const customerContact = row.contact_number || ''

    // ── Claim exactly-once BEFORE building/sending ──────────────────────────
    // The main event is claimed first. Attachments that have their own
    // once-only key (a payment's receipt, the settlement statement) are claimed
    // too, so a confirmation that also settles the booking sends ONE email with
    // both documents and neither is ever re-sent. Every claim is released if the
    // provider rejects the message, so failures stay retryable.
    const claimedKeys: string[] = []
    const claim = async (key: string) => {
      const { data, error }: {
        data: { claimed?: boolean; reason?: string; sent_at?: string } | null
        error: { message: string } | null
      } = await supabase.rpc('claim_booking_email', {
        p_booking_id: bookingId,
        p_event: key,
        p_recipient: email,
        p_sent_by: 'booking-lifecycle',
      })
      if (error) throw new Error(`Could not claim the email delivery: ${error.message}`)
      if (data?.claimed) claimedKeys.push(key)
      return data
    }

    const mainClaim = await claim(lifecycleEvent)
    if (!mainClaim?.claimed) {
      return new Response(JSON.stringify({
        ok: true,
        skipped: true,
        reason: mainClaim?.reason || 'ALREADY_SENT',
        event: lifecycleEvent,
        alreadySentAt: mainClaim?.sent_at,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })
    }

    let attachments: EmailAttachment[] = []
    let subject = ''
    let html = ''
    try {
      // Transaction receipt: the verified payment this event is about.
      let hasReceipt = false
      if (verifiedTransaction && ['payment_verified', 'booking_confirmed'].includes(canonical)) {
        const receiptKey = `payment_verified:${verifiedTransaction.payment_id}`
        const receiptClaimed = receiptKey === lifecycleEvent || (await claim(receiptKey))?.claimed
        if (receiptClaimed) {
          attachments.push({
            content: buildOfficialReceiptPdf({
              customerName,
              customerEmail,
              customerContact,
              bookingReference: bookingRef,
              payment: verifiedTransaction,
            }),
            filename: `Receipt-RCP-${String(verifiedTransaction.payment_id).toUpperCase()}.pdf`,
          })
          hasReceipt = true
        }
      }

      // Statement of Account: once, the first time the ledger reports the
      // booking fully settled.
      let hasStatement = false
      const mayCarryStatement = ['booking_settled', 'payment_verified', 'booking_confirmed', 'booking_in_progress', 'booking_completed', 'booking_released'].includes(canonical)
      if (mayCarryStatement && amounts.fullySettled) {
        const statementClaimed = lifecycleEvent === 'booking_settled' || (await claim('booking_settled'))?.claimed
        if (statementClaimed) {
          attachments.push({
            content: buildStatementOfAccountPdf({
              customerName,
              customerEmail,
              customerContact,
              bookingReference: bookingRef,
              ledger,
              transactions,
              issuedAt: new Date().toISOString(),
            }),
            filename: `Statement-SOA-${bookingRef}.pdf`,
          })
          hasStatement = true
        }
      }
      if (canonical === 'booking_settled' && !amounts.fullySettled) {
        throw new Error('booking_settled requested but the ledger does not report the booking as fully settled')
      }

      // ── Render the right email for this event ─────────────────────────────
      let built: { subject: string; html: string }
      if (canonical === 'booking_confirmed') {
        built = buildBookingConfirmedEmail({ booking: bookingForEmail, payment, ledger, customerName, hasReceipt: hasReceipt || hasStatement })
      } else if (canonical === 'payment_verified') {
        built = buildPaymentVerifiedEmail({ booking: bookingForEmail, payment, ledger, customerName, hasReceipt, hasStatement })
      } else if (canonical === 'booking_settled') {
        built = buildBookingSettledEmail({ booking: bookingForEmail, ledger, customerName })
      } else if (canonical === 'booking_created') {
        built = buildBookingCreatedEmail({ booking: bookingForEmail, payment, ledger, customerName })
      } else if (canonical === 'booking_reminder') {
        built = buildReminderEmail({ booking: bookingForEmail, payment, ledger, customerName })
      } else {
        const statusKey = {
          booking_in_progress: 'IN_PROGRESS',
          booking_completed: 'COMPLETED',
          booking_released: 'RELEASED',
          booking_cancelled: 'CANCELLED',
          booking_flagged_noshow: 'FLAGGED_NOSHOW',
        }[canonical] || requested
        built = buildStatusEmail({ booking: bookingForEmail, payment, ledger, customerName, newStatus: statusKey, remarks: isCustomer ? undefined : remarks })
      }
      subject = built.subject
      html = built.html
    } catch (buildError) {
      for (const key of claimedKeys) {
        await supabase.rpc('release_booking_email_claim', { p_booking_id: bookingId, p_event: key })
      }
      throw buildError
    }

    // ── In-app notification (kept in lockstep with the email) ───────────────
    const statusKey = canonical === 'booking_created' ? 'SCHEDULED'
      : canonical === 'booking_confirmed' ? 'CONFIRMED'
        : canonical === 'booking_in_progress' ? 'IN_PROGRESS'
          : canonical === 'booking_completed' ? 'COMPLETED'
            : canonical === 'booking_released' ? 'RELEASED'
              : canonical === 'booking_cancelled' ? 'CANCELLED'
                : canonical === 'booking_flagged_noshow' ? 'FLAGGED_NOSHOW'
                  : canonical === 'payment_verified' ? 'PAYMENT_VERIFIED'
                    : canonical === 'booking_settled' ? 'BOOKING_SETTLED'
                  : String(requested).toUpperCase()
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
      for (const key of claimedKeys) {
        await supabase.rpc('release_booking_email_claim', { p_booking_id: bookingId, p_event: key })
      }
      // Resend returns a plain object; wrap it so the status mapping (502) and
      // the logged message are meaningful.
      throw new Error(`Email provider rejected the message: ${(sendError as { message?: string }).message || String((sendError as { name?: string }).name || 'unknown error')}`)
    }

    for (const key of claimedKeys) {
      await supabase.rpc('record_booking_email_result', {
        p_booking_id: bookingId,
        p_event: key,
        p_resend_id: sent?.id ?? null,
      })
    }

    return new Response(JSON.stringify({
      ok: true,
      event: lifecycleEvent,
      to: email,
      subject,
      attachments: attachments.length,
      claimed: claimedKeys,
      resendId: sent?.id ?? null,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })

  } catch (error: unknown) {
    // ── Status discipline ─────────────────────────────────────────────────
    //
    // Everything used to return 400, including a Supabase outage, a missing RLS
    // policy, and a Resend rejection. That is why this function's console was
    // full of 400s that looked like bad CALLS when they were server faults — and
    // why the frontend's `FunctionsHttpError` carried no usable signal.
    //
    //   400 -> the CALLER's request is malformed (missing bookingId)
    //   404 -> the booking does not exist
    //   502 -> the mail provider rejected the message
    //   500 -> anything else
    const message = error instanceof Error ? error.message : String(error)
    let status = 500
    if (/is required/i.test(message)) status = 400
    else if (/Booking not found|No customer email/i.test(message)) status = 404
    else if (/claim|delivery/i.test(message)) status = 500
    else if (/resend|email|provider|domain|api key/i.test(message)) status = 502

    console.error('[booking-lifecycle]', status, message)
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status,
    })
  }
})