import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { renderEmail, formatPeso, formatDateTime } from "../_shared/emailLayout.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json();
    const { bookingId, refundReference } = body;

    if (!bookingId || !refundReference) {
      throw new Error('Missing bookingId or refundReference in request payload.');
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    const authHeader = req.headers.get('Authorization');
    const accessToken = authHeader?.replace(/^Bearer\s+/i, '');
    if (!accessToken) throw new Error('Authentication is required.');

    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !user) throw new Error('Authenticated user not found.');

    const { data: adminProfile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (adminProfile?.role?.toUpperCase() !== 'ADMIN') {
      throw new Error('Administrator access is required.');
    }

    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .select(`
        *,
        customer:profiles!bookings_customer_id_fkey(full_name, email),
        vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services(*))
      `)
      .eq('id', bookingId)
      .single();
    if (bookingError || !booking) throw new Error(`Booking not found: ${bookingError?.message || 'Unknown error'}`);

    const { data: refundPayment, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('amount, reference_number, refund_reason')
      .eq('booking_id', bookingId)
      .eq('method', 'SYSTEM_REFUND')
      .eq('reference_number', refundReference)
      .eq('status', 'REFUNDED')
      .lt('amount', 0)
      .single();
    if (paymentError || !refundPayment) throw new Error(`Valid refund ledger entry not found: ${paymentError?.message || 'Unauthorized or missing'}`);

    const customerEmail = booking.customer?.email || booking.customer_email;
    const customerName = booking.customer_name || booking.customer?.full_name || '';
    const refundAmount = Math.abs(Number(refundPayment.amount || 0));
    const refundReason = refundPayment.refund_reason || '';
    const serviceNames = (booking.vehicles || [])
      .flatMap((vehicle: any) => (vehicle.services || []).map((service: any) => service.service_name))
      .filter(Boolean);
    const vehicleNames = (booking.vehicles || [])
      .map((vehicle: any) => [vehicle.brand, vehicle.model, vehicle.plate_number].filter(Boolean).join(' '))
      .filter(Boolean);
    const bookingRef = bookingId.substring(0, 8).toUpperCase();

    if (!customerEmail) throw new Error('No customer email found for this booking.');
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (!resendApiKey) throw new Error('Missing RESEND_API_KEY environment variable.');
    // The one no-reply sender for every email (the domain is verified in Resend); replies go to the shop inbox.
    const resendFrom = Deno.env.get('EMAIL_FROM') || 'Comar Garage <noreply@comargarage.com>';
    const { data: shopRow } = await supabaseAdmin.from('business_config')
      .select('business_name, business_address, contact_number, email_address')
      .order('id', { ascending: true }).limit(1).maybeSingle();
    const shopEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(shopRow?.email_address || '')) ? String(shopRow?.email_address) : '';
    const siteUrl = String(Deno.env.get('SITE_URL') || 'https://comargarage.com').replace(/\/+$/, '');
    const first = String(customerName).trim().split(/\s+/)[0] || '';

    const { html, text } = renderEmail({
      title: 'Your refund was sent',
      preheader: `${formatPeso(refundAmount)} refunded for booking #${bookingRef}.`,
      greeting: first ? `Hi ${first},` : 'Hi,',
      blocks: [
        `We sent you a refund of **${formatPeso(refundAmount)}** for booking **#${bookingRef}**.`,
        { type: 'rows', title: 'Refund details', rows: [
          ['Refund amount', formatPeso(refundAmount), { strong: true }],
          ['Refund reference', String(refundReference)],
          ['Reason', refundReason],
          ['Booking no.', bookingRef],
          ['Appointment', booking.start_datetime ? formatDateTime(booking.start_datetime) : ''],
          ['Services', serviceNames.join(', ')],
          ['Vehicle', vehicleNames.join(', ')],
        ] },
        { type: 'notice', tone: 'info', text: 'Bank and e-wallet refunds can take 3 to 5 business days to show in your account. Cash refunds are handed over at the shop.' },
      ],
      cta: { label: 'View my booking', url: `${siteUrl}/login?next=${encodeURIComponent(`/customer/bookings/${bookingId}`)}` },
      reason: 'You get this email because a refund was made on your Comar Garage booking.',
      shop: {
        name: shopRow?.business_name ? String(shopRow.business_name).toLowerCase().replace(/\b([a-z])/g, (m: string) => m.toUpperCase()) : 'Comar Garage',
        address: shopRow?.business_address || undefined,
        phone: shopRow?.contact_number || undefined,
        email: shopEmail || undefined,
        site: siteUrl,
      },
    });

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendApiKey}`
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [customerEmail],
        ...(shopEmail ? { reply_to: shopEmail } : {}),
        subject: `Your refund of ${formatPeso(refundAmount)} was sent (#${bookingRef})`,
        html,
        text,
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Failed to send email via Resend');
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error: unknown) {
    // `error` is `unknown` in a catch clause: reading `.message` off it directly
    // is a type error (TS18046) and is NOT guaranteed to be an Error at runtime —
    // a thrown string or object would produce `undefined`. Normalise it first.
    const message = error instanceof Error ? error.message : String(error)
    const isAuthorizationFailure = /Authentication|Authenticated user|Administrator access/i.test(message)
    return new Response(JSON.stringify({
      error: message,
      ...(isAuthorizationFailure ? {} : { emailPending: true }),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      // A refund is already committed before this function is called. Return
      // a structured pending result for delivery/configuration failures so the
      // admin UI can keep the refund and offer retry without a misleading
      // generic network failure. Authentication/authorization still fail hard.
      status: isAuthorizationFailure ? 403 : 200,
    })
  }
})
