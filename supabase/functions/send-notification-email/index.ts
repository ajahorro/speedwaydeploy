import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const resend = new Resend(Deno.env.get('RESEND_API_KEY'))
const resendFrom = Deno.env.get('RESEND_FROM') || 'Comar Garage <notifications@speedway-autoxmoto.xyz>'
const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
const escapeHtml = (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { notificationId } = await req.json()
    if (!notificationId) throw new Error('Notification ID is required.')

    const { data: notification, error: notificationError } = await supabase
      .from('notifications')
      .select('id, user_id, booking_id, title, message, action_url')
      .eq('id', notificationId)
      .single()
    if (notificationError || !notification) throw new Error(notificationError?.message || 'Notification not found.')

    const { data: recipient, error: recipientError } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('id', notification.user_id)
      .maybeSingle()
    if (recipientError) throw recipientError
    const email = recipient?.email
    if (!email) return new Response(JSON.stringify({ ok: true, skipped: 'recipient has no email' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const bookingRef = notification.booking_id ? `#${notification.booking_id.slice(0, 8).toUpperCase()}` : ''
    const subject = `${notification.title}${bookingRef ? ` ${bookingRef}` : ''} - Speedway`
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;color:#111827"><div style="background:#a91b18;padding:22px;text-align:center;color:#fff"><h1 style="margin:0;font-size:22px;letter-spacing:2px">SPEEDWAY AUTOXMOTO</h1></div><div style="padding:28px"><p>Hi ${escapeHtml(recipient?.full_name || 'Valued Customer')},</p><h2 style="color:#a91b18">${escapeHtml(notification.title)}</h2><p style="font-size:15px;line-height:1.7">${escapeHtml(notification.message)}</p>${notification.action_url ? `<p><a href="${escapeHtml(notification.action_url)}" style="display:inline-block;background:#a91b18;color:#fff;padding:12px 20px;border-radius:5px;text-decoration:none;font-weight:700">VIEW IN PORTAL</a></p>` : ''}</div><div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#6b7280">Speedway Detail Studio</div></div>`
    const { data, error } = await resend.emails.send({ from: resendFrom, to: [email], subject, html })
    if (error) throw error
    return new Response(JSON.stringify({ ok: true, data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
  }
})
