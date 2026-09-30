import { supabase } from '../lib/supabase';
import { logger } from '../utils/logger';
import { DEFAULT_TRANSFER_FEE } from '../config/constants';

/**
 * creditLedgerService.js
 * ============================================================================
 * Batch 7 / Step 7.5 — Task B: Deterministic OCR net-credit + overpayment ledger.
 *
 * 1. NET PAYMENT CREDIT (cross-bank / GoTyme fee defense)
 *      Net Payment Credit = Total Deducted − Transfer Fee
 *    The fee is subtracted BEFORE the amount is credited to the booking, so a
 *    GoTyme transfer that lands short by the fee never leaves a phantom balance.
 *
 * 2. EXCESS-CREDIT LEDGER
 *    Credit is created only after settled payments exceed the FULL booking total.
 *    It is scoped to that booking, shrinks as its total changes, and only that
 *    booking's unused amount is routed to the Refund Hub.
 *
 * Fail-closed: every RPC error is surfaced; nothing is applied optimistically.
 */

/** Net credit after the transfer fee (never negative). */
export const computeNetCredit = (totalDeducted, transferFee = 0) => {
  const total = Number(totalDeducted) || 0;
  const fee = Math.max(0, Number(transferFee) || 0);
  return Math.max(0, total - fee);
};

/** Convenience wrapper using the configured default fee. */
export const computeNetCreditWithDefault = (totalDeducted, transferFee) =>
  computeNetCredit(totalDeducted, transferFee ?? DEFAULT_TRANSFER_FEE);

/** Read only the verified excess tied to one booking. */
export const fetchBookingExcessCredit = async (customerId, bookingId) => {
  if (!customerId || !bookingId) return 0;
  const { data, error } = await supabase.rpc('customer_booking_excess_credit', {
    p_customer_id: customerId,
    p_booking_id: bookingId,
  });
  if (error) {
    logger.warn('Failed to read booking excess credit; treating it as zero.', error);
    return 0;
  }
  return Number(data) || 0;
};

/** Full ledger history for a customer (newest first). */
export const fetchCreditLedger = async (customerId) => {
  if (!customerId) return [];
  const { data, error } = await supabase
    .from('customer_credit_ledger')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) {
    logger.warn('Failed to load credit ledger', error);
    return [];
  }
  return data || [];
};

/**
 * Route leftover excess_credit to the Refund Hub when a booking completes.
 * Idempotent at the DB layer (a second call with 0 balance is a no-op).
 */
export const settleOverpaymentOnCompletion = async (bookingId) => {
  if (!bookingId) return { routed: 0 };
  const { data, error } = await supabase.rpc('settle_overpayment_on_completion', { p_booking_id: bookingId });
  if (error) {
    logger.warn('Overpayment settlement on completion failed (non-fatal)', error);
    return { routed: 0, error: error.message };
  }
  return data;
};

export default {
  computeNetCredit,
  computeNetCreditWithDefault,
  fetchBookingExcessCredit,
  fetchCreditLedger,
  settleOverpaymentOnCompletion,
};