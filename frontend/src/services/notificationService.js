import { supabase } from '../lib/supabase';
import { subscribeTable } from '../lib/realtimeHub';
import { isNotificationActionable } from '../utils/notificationRouting';

/**
 * notificationService.js
 * Handles customer-facing notification management.
 */

export const fetchNotifications = async (userId) => {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []).filter(isNotificationActionable);
};

export const markNotificationAsRead = async (notificationId) => {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId);

  if (error) throw error;
};

export const markAllAsRead = async (userId) => {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) throw error;
};

export const deleteNotification = async (notificationId) => {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('id', notificationId);

  if (error) throw error;
};

export const clearAllNotifications = async (userId) => {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId);

  if (error) throw error;
};

export const subscribeToNotifications = (userId, callback) => {
  // Shared channel: every screen listening to this user's notifications uses one.
  const stop = subscribeTable({ table: 'notifications', filter: `user_id=eq.${userId}` }, callback);
  return { unsubscribe: stop };
};

/**
 * Send the single lifecycle email for a booking event.
 *
 * ONE dispatch point for every customer booking email. The function itself owns
 * the templates, the money model and the exactly-once guard, so the client only
 * says WHICH event happened — it never assembles or de-duplicates mail.
 *
 * Events this client fires:
 *   'booking_created'   — on submit. Carries the payment-as-submitted and what
 *                         the OCR read. No receipt (money not verified yet).
 *   'booking_confirmed' — on admin verification. Carries the receipt PDF.
 *   a raw status        — on any other status change.
 *
 * @param {string} bookingId
 * @param {string} event  lifecycle keyword or raw status
 * @param {object} [opts] { remarks, reminder, eventKey }
 * `eventKey` is reserved for a deliberate lifecycle reset/re-notification and
 * must be stable across retries of that same action.
 */
/**
 * Pull the body out of a FunctionsHttpError so the console shows WHY the edge
 * function refused, not just "non-2xx status code".
 *
 * The Supabase client wraps a non-2xx response in a FunctionsHttpError whose
 * `.context` is the raw Response — the useful `{ error: ... }` payload was
 * previously discarded, so every failure logged the same opaque line.
 */
const describeFunctionError = async (error) => {
  try {
    const response = error?.context;
    if (response && typeof response.json === 'function') {
      const body = await response.clone().json();
      const detail = body?.error || body?.message || body?.skipped;
      if (detail) return `${error.message || 'Edge function failed'} — ${detail}`;
    }
  } catch {
    // Fall through to the generic message.
  }
  return error?.message || 'Edge function failed';
};

export const sendStatusEmail = async (bookingId, event, opts = {}) => {
  try {
    const { data, error } = await supabase.functions.invoke('booking-lifecycle', {
      body: {
        bookingId,
        event,
        // Kept for backwards compatibility with callers that pass a status.
        newStatus: typeof opts === 'string' ? opts : opts.newStatus,
        remarks: typeof opts === 'string' ? '' : (opts.remarks || ''),
        reminder: typeof opts === 'string' ? false : Boolean(opts.reminder),
        eventKey: typeof opts === 'string' ? undefined : opts.eventKey,
      }
    });

    if (error) throw error;
    if (data?.skipped) {
      console.info(`[NotificationService] ${event} email already sent for ${bookingId} — duplicate suppressed.`);
    }
    return data;
  } catch (error) {
    console.error('[NotificationService] Error:', await describeFunctionError(error));
    return { error: await describeFunctionError(error) };
  }
};

export const sendBookingConfirmationEmail = async (bookingId) => {
  // The confirmation event is the one that carries the official receipt PDF.
  return sendStatusEmail(bookingId, 'booking_confirmed');
};

/**
 * Trigger the post-verification confirmation + receipt email.
 * Idempotent at the DATABASE level: a second call for the same booking is
 * refused by booking_email_deliveries, so an admin retrying a verification that
 * already mailed the receipt will not mail it twice.
 */
export const sendPaymentVerifiedEmail = async (bookingId) => {
  return sendStatusEmail(bookingId, 'booking_confirmed');
};

/**
 * REQ-SYS-02: Automated Status Notification Trigger
 *
 * Delegates to the booking-lifecycle edge function, which is the SINGLE source
 * of truth for booking emails. It owns the templates, the money model and the
 * exactly-once guard, so no caller can produce a duplicate or a mail that
 * disagrees with the portal's figures.
 *
 * @deprecated prefer the named helpers below, which state the EVENT rather than
 * a bare status string. Kept so existing call sites keep working.
 */
export const sendStatusEmailLegacy = async (bookingId, newStatus, remarks = '') => {
  try {
    const { data, error } = await supabase.functions.invoke('booking-lifecycle', {
      body: { bookingId, event: newStatus, newStatus, remarks }
    });
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('[NotificationService] Error:', error);
    return { error: error.message };
  }
};

export const sendNotificationEmail = async (notificationId) => {
  try {
    const { data, error } = await supabase.functions.invoke('send-notification-email', {
      body: { notificationId }
    });
    if (error) throw error;
    // A skipped send is a normal, expected outcome (the row was absent, or the
    // recipient has no email) — not an error. Surfaced at info level so it does
    // not read as a failure in the console.
    if (data?.skipped) {
      console.info(`[NotificationService] Notification email skipped: ${data.skipped}`);
    }
    return data;
  } catch (error) {
    // A failure here is non-fatal by design: the in-app notification row is
    // already persisted, so the bell still shows it. Log it with the cause the
    // edge function returned instead of a generic line, so an outage is
    // distinguishable from a bad id.
    const detail = await describeFunctionError(error);
    console.warn(`[NotificationService] Notification email not sent: ${detail}`);
    return { error: detail };
  }
};
