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
