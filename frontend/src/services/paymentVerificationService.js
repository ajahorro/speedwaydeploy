import { supabase } from '../lib/supabase';
import { BACKEND_URL, authHeaders } from '../config/api';
import { normalizeBookingLedger } from './ledgerService';

/**
 * The ONLY way an admin screen approves or rejects a payment.
 *
 * Both Admin Payments and Admin Booking Details call these functions, so a
 * verification has the same write, lock, audit and reconciliation behaviour
 * no matter which screen it came from. The work happens in two database RPCs
 * (admin_verify_payment / admin_reject_payment, migration 20261024000003),
 * followed by the backend reconciliation that advances the booking and staff
 * assignment notices.
 */

/**
 * Advance booking status and staff task notices after a money change. Passing
 * the verified payment lets the server email its receipt (exactly once).
 */
export const reconcilePaymentState = async (bookingId, paymentId = null) => {
  const response = await fetch(`${BACKEND_URL}/api/bookings/reconcile-payment-state`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(paymentId ? { bookingId, paymentId } : { bookingId })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success) throw new Error(result.error || 'Booking workflow update failed.');
  return result;
};

const finish = async (bookingId, data, paymentId = null) => {
  let reconciliation = null;
  let reconcileError = null;
  try {
    reconciliation = await reconcilePaymentState(bookingId, paymentId);
  } catch (error) {
    reconcileError = error;
  }
  return {
    ...data,
    ledger: normalizeBookingLedger(data?.ledger),
    warnings: reconciliation?.warnings || [],
    reconcileError
  };
};

/**
 * Approve a submitted payment.
 * @param {object}  args
 * @param {object}  args.payment          payments row (needs id, booking_id)
 * @param {number}  args.verifiedAmount   amount the admin confirms was received
 * @param {boolean} [args.override=false] true when overriding the OCR reading
 * @param {string}  [args.note]
 */
export const verifyPayment = async ({ payment, verifiedAmount, override = false, note = null }) => {
  const { data, error } = await supabase.rpc('admin_verify_payment', {
    p_payment_id: payment.id,
    p_booking_id: payment.booking_id,
    p_verified_amount: Number(verifiedAmount || 0),
    p_note: note,
    p_override: Boolean(override)
  });
  if (error) throw error;
  return finish(payment.booking_id, data, payment.id);
};

/**
 * Reject a submitted payment.
 * @param {object}  args
 * @param {object}  args.payment
 * @param {string}  args.reason
 * @param {boolean} args.queueRefund  true: funds were received → hold as
 *                                    REFUND_PENDING and queue a refund.
 *                                    false: invalid proof → REJECTED, customer re-submits.
 * @param {string}  [args.refundNote]
 */
export const rejectPayment = async ({ payment, reason, queueRefund, refundNote = null }) => {
  const { data, error } = await supabase.rpc('admin_reject_payment', {
    p_payment_id: payment.id,
    p_booking_id: payment.booking_id,
    p_reason: reason,
    p_queue_refund: Boolean(queueRefund),
    p_refund_note: refundNote
  });
  if (error) throw error;
  return finish(payment.booking_id, data);
};
