import { supabase } from '../lib/supabase';
import { BACKEND_URL } from '../config/api';

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
  return data || [];
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
  return supabase
    .channel(`notifications-${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*', // Listen to inserts, updates, deletes
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`
      },
      callback
    )
    .subscribe(); // .subscribe() MUST be at the very end!
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
 */
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
    console.error('[NotificationService] Error:', error);
    return { error: error.message };
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

export const sendPaymentReceiptEmail = async (bookingId, paymentId) => {
  try {
    console.info(`[Email] Sending payment receipt for ${bookingId}/${paymentId}`);
    const response = await fetch(`${BACKEND_URL}/api/emails/payment-receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId, paymentId })
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `Email request failed (${response.status})`);
    console.info(`[Email] Payment receipt accepted for ${bookingId}/${paymentId}`);
    return result;
  } catch (error) {
    console.error('[NotificationService] Payment Email Error:', error);
    return { error: error.message };
  }
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
    return data;
  } catch (error) {
    console.error('[NotificationService] Notification email error:', error);
    return { error: error.message };
  }
};

