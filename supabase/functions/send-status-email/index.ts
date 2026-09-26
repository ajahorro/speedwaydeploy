import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

/**
 * send-status-email — RETIRED. Now a hard redirection, not a second mailer.
 *
 * WHY THIS IS A SHIM AND NOT A DELETION
 * -------------------------------------
 * This function used to assemble and send booking emails itself, with its own
 * templates and its own money maths. Having a SECOND email path is precisely
 * what flooded customers: one booking produced a "Payment Submitted" mail from
 * the client event engine AND a "Booking is now SCHEDULED" mail from here,
 * quoting two different amounts.
 *
 * Every booking email now comes from ONE place — `booking-lifecycle` — which
 * owns the templates, the money model and the database-level exactly-once
 * guard. This name is kept only so that any un-migrated caller (a stale tab, an
 * old deploy, a bookmarked admin action) is REDIRECTED into that single path
 * instead of silently producing a duplicate. It never sends mail of its own.
 *
 * Safe to delete once no caller references it.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { bookingId, newStatus, event, remarks, reminder = false } = await req.json()

    console.warn('[send-status-email] RETIRED — redirecting to booking-lifecycle instead of sending.')

    const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-lifecycle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({
        bookingId,
        event: event || newStatus || 'booking_created',
        remarks,
        reminder,
      }),
    })

    const result = await response.json().catch(() => ({}))

    return new Response(JSON.stringify({
      ok: response.ok,
      redirectedTo: 'booking-lifecycle',
      ...result,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error)?.message || String(error) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const resend = new Resend(Deno.env.get('RESEND_API_KEY'))
const resendFrom = Deno.env.get('RESEND_FROM') || 'Speedway <notifications@speedway-autoxmoto.xyz>'
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

const templates = {
  SCHEDULED: 'Your booking has been received. Your scheduled time is confirmed. Your payment is to be verified manually by the admin before we confirm your booking.',
  CONFIRMED: 'Your appointment is locked in! See you at Speedway.',
  ONGOING: "Great news! We've started detailing your vehicle.",
  IN_PROGRESS: "Great news! We've started detailing your vehicle.",
  COMPLETED: 'Your ride is ready for pickup! Check your portal for the final receipt.',
  RELEASED: 'Your vehicle has been released. Thank you for choosing Speedway. Please come again for your future Auto x Moto needs! Create an account on our website to see more and hear about future promos if you have not yet!',
  CANCELLED: 'Your booking has been cancelled. Please check your portal for details regarding your refund or rescheduling.',
  FLAGGED_NOSHOW: 'We missed you! Your slot has expired. Visit the Refund Hub for details.'
}

// ────────────────────────────────────────────────────────────────────────────
// MONEY MODEL (mirrors backend/services/transactionAmounts.js)
//
// This function used to quote `booking.total_amount` alone, so it disagreed
// with the receipt whenever the booking had a promo, a partial payment, or an
// OCR-read figure that differed from what the customer declared. One payment
// therefore produced two emails quoting two different amounts.
//
//   gross (what the customer sent)  = detected + transfer fee
//   net   (what the shop received)  = detected_amount
//   due   (what the booking costs)  = total_amount
//
// VAT is INCLUDED in the published prices and only broken out for compliance.
// ────────────────────────────────────────────────────────────────────────────
const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const formatPeso = (value) =>
  `₱${num(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const resolveAmounts = (booking, payment) => {
  const bookingTotal = num(booking?.total_amount)
  const declared = num(payment?.amount)
  const detectedNet = num(payment?.detected_amount)
  const recordedNet = num(payment?.net_credit)
  const transferFee = Math.max(0, num(payment?.transfer_fee))

  const netReceived = detectedNet > 0 ? detectedNet : (recordedNet > 0 ? recordedNet : declared)
  const grossPaid = detectedNet > 0
    ? detectedNet + transferFee
    : (declared > 0 ? declared : netReceived)

  const creditApplied = Math.max(0, num(payment?.credit_applied))
  const netApplied = netReceived + creditApplied
  // The TRANSFER FEE IS NOT A SHORTFALL. The customer paid it; the bank kept it
  // in transit. Crediting the gross keeps a cross-bank transfer from reading as
  // short-paid. Must match backend/services/transactionAmounts.js exactly.
  const creditedToBooking = netApplied + transferFee
  const remainingBalance = Math.max(0, bookingTotal - creditedToBooking)
  const excessCredit = Math.max(0, creditedToBooking - bookingTotal)

  return {
    bookingTotal,
    grossPaid,
    netReceived,
    transferFee,
    creditApplied,
    netApplied,
    creditedToBooking,
    remainingBalance,
    excessCredit,
    hasPayment: Boolean(payment),
    paymentStatus: String(payment?.status || '').toUpperCase(),
  }
}

/**
 * Render the payment block for the lifecycle email. Present ONLY when a payment
 * actually exists, so an admin-side status change does not claim a payment was
 * made. Showing the received amount here is what lets ONE email replace the two
 * the customer used to get (a status mail AND a separate payment-submitted mail).
 */
const renderPaymentBlock = (amounts) => {
  if (!amounts?.hasPayment) return ''

  const rows = []
  rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Amount Paid</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.grossPaid)}</td></tr>`)

  if (amounts.transferFee > 0) {
    rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Transfer Fee (absorbed)</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.transferFee)}</td></tr>`)
    rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Amount Received</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.netReceived)}</td></tr>`)
  }

  if (amounts.creditApplied > 0) {
    rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Credit Applied</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">- ${formatPeso(amounts.creditApplied)}</td></tr>`)
  }

  if (amounts.excessCredit > 0) {
    rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">Recorded as Excess Credit</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.excessCredit)}</td></tr>`)
  }

  rows.push(`<tr><td style="padding:10px 14px;color:#6b7280;font-size:13px;">${amounts.remainingBalance > 0 ? 'Balance Still Due' : 'Booking Total'}</td><td style="padding:10px 14px;text-align:right;font-weight:700;font-size:13px;">${formatPeso(amounts.remainingBalance > 0 ? amounts.remainingBalance : amounts.bookingTotal)}</td></tr>`)

  const statusNote = amounts.paymentStatus === 'FOR_VERIFICATION'
    ? `<div style="margin-top:12px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #f59e0b;border-radius:6px;font-size:12px;color:#92400e;">Your payment is queued for verification. This is not yet an official receipt — we will confirm once our team has reviewed it.</div>`
    : amounts.paymentStatus === 'PAID'
      ? `<div style="margin-top:12px;padding:10px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-left:4px solid #10b981;border-radius:6px;font-size:12px;color:#065f46;">Payment verified. An official receipt is available in your portal.</div>`
      : ''

  return `
    <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:24px 0 10px;">Payment</div>
    <table role="presentation" style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;">${rows.join('')}</table>
    ${statusNote}`
}

const escapeHtml = (value: unknown) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')

// Lifecycle mirrors the statuses that actually exist in the system. There is no
// 'QUALITY CHECK' state — it was a stale label that never had a backing status.
const lifecycleSteps = ['SCHEDULED', 'CONFIRMED', 'IN PROGRESS', 'COMPLETED', 'RELEASED']

const renderLifecycle = (statusKey: string) => {
  const normalized = statusKey === 'ONGOING' ? 'IN PROGRESS' : statusKey.replaceAll('_', ' ')
  const activeIndex = lifecycleSteps.indexOf(normalized)
  const isException = ['CANCELLED', 'FLAGGED NOSHOW'].includes(normalized)
  return `<div style="margin: 28px 0; padding: 18px 10px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px;">
    <div style="font-size: 11px; color: #6b7280; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 16px;">Booking lifecycle</div>
    <table role="presentation" style="width: 100%; border-collapse: collapse;"><tr>
      ${lifecycleSteps.map((step, index) => {
        const isActive = index === activeIndex
        const isPast = activeIndex >= 0 && index < activeIndex
        const color = isException && index === 0 ? '#dc2626' : (isActive || isPast ? '#e61e2a' : '#cbd5e1')
        return `<td style="width: ${100 / lifecycleSteps.length}%; text-align: center; vertical-align: top;">
          <div style="margin: 0 auto 8px; width: 18px; height: 18px; line-height: 18px; border-radius: 50%; background: ${color}; color: #fff; font-size: 11px; font-weight: 700;">${isPast || isActive ? '&#10003;' : ''}</div>
          <div style="font-size: 10px; line-height: 13px; color: ${isActive ? '#111827' : '#6b7280'}; font-weight: ${isActive ? '700' : '400'};">${step}</div>
        </td>`
      }).join('')}
    </tr></table>
    ${isException ? `<div style="margin-top: 12px; text-align: center; color: #dc2626; font-size: 12px; font-weight: 700;">${escapeHtml(normalized)}</div>` : ''}
  </div>`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Security check: service_role or secret header
  const authHeader = req.headers.get('Authorization')
  if (!authHeader && !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  try {
    const { bookingId, newStatus, remarks, reminder = false } = await req.json()

    // Fetch booking + customer info. The PAYMENT is fetched too: including it
    // here is what lets ONE email carry both the status change and the money,
    // replacing the separate "Payment Submitted" mail that duplicated this one.
    const { data: booking, error: bError } = await supabase
      .from('bookings')
      .select(`
        id,
        customer_id,
        customer_name,
        customer_email,
        total_amount,
        status,
        payment_status,
        payment_method,
        start_datetime,
        profiles:profiles!bookings_customer_id_fkey (
          full_name,
          email
        ),
        payments:payments!payments_booking_id_fkey (
          id,
          amount,
          detected_amount,
          net_credit,
          transfer_fee,
          credit_applied,
          status,
          method,
          created_at
        )
      `)
      .eq('id', bookingId)
      .single()

    if (bError || !booking) {
      throw new Error(`Booking not found: ${bError?.message}`)
    }

    // One payment per submission in this workflow; if several ever exist, the
    // newest is the one this status change is about.
    const payments = Array.isArray((booking as any).payments) ? (booking as any).payments : []
    const payment = payments.length
      ? [...payments].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0]
      : null

    const amounts = resolveAmounts(booking, payment)

    const customer = booking.profiles
    const email = customer?.email || booking.customer_email
    const name = escapeHtml(customer?.full_name || booking.customer_name || 'Valued Customer')
    const statusKey = newStatus.toUpperCase()
    const appointmentDate = booking.start_datetime
      ? new Date(booking.start_datetime).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })
      : 'your scheduled time'

    if (!email) {
      throw new Error('No customer email found for this booking.')
    }
    
    const subject = reminder
      ? `Reminder: Your confirmed Speedway appointment is in 1 hour`
      : amounts.hasPayment && !amounts.remainingBalance && amounts.paymentStatus !== 'FOR_VERIFICATION'
        ? `Speedway: Booking #${bookingId.slice(0, 8).toUpperCase()} confirmed — ${formatPeso(amounts.netApplied)} received`
        : `Speedway Update: Booking #${bookingId.slice(0, 8).toUpperCase()} is now ${statusKey}`
    const content = reminder
      ? `This is a reminder that your confirmed appointment is scheduled for ${appointmentDate}. Please arrive on time. If service has not started within one hour after your scheduled time, the booking will be flagged as a No-Show.`
      : templates[statusKey] || `Your booking status has been updated to ${newStatus}.`

    const reasonHtml = remarks ? `<p style="margin-top: 15px; padding: 10px; background: #222; border-left: 4px solid #a91b18;"><strong>Note/Reason:</strong> ${remarks}</p>` : ''

    const html = `
      <div style="font-family: 'Segoe UI', Tahoma, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff; color: #111827; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
        <div style="background: #a91b18; padding: 22px; text-align: center; color: #ffffff;"><h1 style="margin: 0; font-size: 23px; letter-spacing: 2px;">SPEEDWAY AUTOXMOTO</h1></div>
        <div style="padding: 30px;">
          <h2 style="color: #a91b18; margin: 0 0 18px;">${reminder ? 'Appointment Reminder' : 'Booking Status Update'}</h2>
          <p style="font-size: 16px;">Hi ${name},</p>
          <p style="font-size: 15px; line-height: 1.6;">${escapeHtml(content)}</p>
          ${renderLifecycle(statusKey)}
          <table role="presentation" style="width: 100%; border-collapse: collapse; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px;">
            <tr><td style="padding: 12px 14px; color: #6b7280; font-size: 13px;">Booking ID</td><td style="padding: 12px 14px; text-align: right; font-weight: 700; font-size: 13px;">${escapeHtml(bookingId)}</td></tr>
            <tr><td style="padding: 12px 14px; color: #6b7280; font-size: 13px;">Booking Total</td><td style="padding: 12px 14px; text-align: right; font-weight: 700; font-size: 13px;">${formatPeso(amounts.bookingTotal)}</td></tr>
            ${amounts.hasPayment ? `<tr><td style="padding: 12px 14px; color: #6b7280; font-size: 13px;">Amount Paid</td><td style="padding: 12px 14px; text-align: right; font-weight: 700; font-size: 13px;">${formatPeso(amounts.grossPaid)}</td></tr>` : ''}
            ${amounts.remainingBalance > 0 && amounts.hasPayment ? `<tr><td style="padding: 12px 14px; color: #6b7280; font-size: 13px;">Balance Still Due</td><td style="padding: 12px 14px; text-align: right; font-weight: 700; font-size: 13px;">${formatPeso(amounts.remainingBalance)}</td></tr>` : ''}
            <tr><td style="padding: 12px 14px; color: #6b7280; font-size: 13px;">Scheduled Time</td><td style="padding: 12px 14px; text-align: right; font-weight: 700; font-size: 13px;">${escapeHtml(appointmentDate)}</td></tr>
          </table>
          ${renderPaymentBlock(amounts)}
          ${reasonHtml}
          <div style="margin-top: 28px; text-align: center;"><a href="https://speedway-autoxmoto.com/portal" style="background: #a91b18; color: #ffffff; padding: 13px 26px; text-decoration: none; border-radius: 5px; font-weight: 700; display: inline-block;">VIEW IN PORTAL</a></div>
        </div>
        <div style="background: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #6b7280;">&copy; 2024 Speedway AutoxMoto. All Rights Reserved.</div>
      </div>`

    const notificationCopy: Record<string, { title: string; message: string; type: string }> = {
      SCHEDULED: {
        title: 'Booking Received',
        message: `Your booking #${bookingId.slice(0, 8).toUpperCase()} has been submitted and is awaiting confirmation.`,
        type: 'BOOKING_CREATED',
      },
      CONFIRMED: {
        title: 'Booking Confirmed',
        message: `Your appointment #${bookingId.slice(0, 8).toUpperCase()} has been confirmed.`,
        type: 'BOOKING_CONFIRMED',
      },
      IN_PROGRESS: {
        title: 'Service Started',
        message: `Work has started on booking #${bookingId.slice(0, 8).toUpperCase()}.`,
        type: 'SERVICE_STARTED',
      },
      ONGOING: {
        title: 'Service Started',
        message: `Work has started on booking #${bookingId.slice(0, 8).toUpperCase()}.`,
        type: 'SERVICE_STARTED',
      },
      COMPLETED: {
        title: 'Service Completed',
        message: `Service for booking #${bookingId.slice(0, 8).toUpperCase()} is complete and ready for pickup.`,
        type: 'SERVICE_COMPLETED',
      },
      RELEASED: {
        title: 'Booking Released',
        message: `Booking #${bookingId.slice(0, 8).toUpperCase()} has been released.`,
        type: 'BOOKING_RELEASED',
      },
      CANCELLED: {
        title: 'Booking Cancelled',
        message: `Booking #${bookingId.slice(0, 8).toUpperCase()} was cancelled.`,
        type: 'BOOKING_CANCELLED',
      },
      FLAGGED_NOSHOW: {
        title: 'Booking Flagged as No-Show',
        message: `Booking #${bookingId.slice(0, 8).toUpperCase()} was flagged after the arrival window expired.`,
        type: 'BOOKING_FLAGGED_NOSHOW',
      },
    }
    const notification = notificationCopy[statusKey]
    if (notification && booking.customer_id) {
      const { error: notificationError } = await supabase.from('notifications').insert({
        user_id: booking.customer_id,
        booking_id: booking.id,
        action_url: `/customer/bookings/${booking.id}`,
        title: reminder ? 'Appointment Reminder' : notification.title,
        message: reminder ? `Your appointment #${bookingId.slice(0, 8).toUpperCase()} is scheduled in 1 hour.` : notification.message,
        notification_type: reminder ? 'BOOKING_REMINDER' : notification.type,
        is_read: false,
      })
      if (notificationError) {
        console.error('Notification persistence failed before email delivery:', notificationError)
      }
    }

    const { data, error } = await resend.emails.send({
      from: resendFrom,
      to: [email],
      subject: subject,
      html: html,
    })

    if (error) throw error

    return new Response(JSON.stringify({ ok: true, data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
