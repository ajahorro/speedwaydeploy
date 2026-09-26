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
 *    When a customer pays more than required, the surplus becomes `excess_credit`.
 *    On adding a service that needs downpayment D:
 *      * D <= excess_credit  -> auto-absorb, prompt for 0.
 *      * D  > excess_credit  -> absorb all credit, prompt only for D − credit.
 *    On booking COMPLETED, any leftover excess_credit is routed to the Refund Hub.
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

/** Read the live excess-credit balance for a customer. */
export const fetchExcessCredit = async (customerId) => {
  if (!customerId) return 0;
  const { data, error } = await supabase.rpc('customer_excess_credit', { p_customer_id: customerId });
  if (error) {
    logger.warn('Failed to read excess credit; defaulting to 0 (fail-closed on spend).', error);
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
 * Record an overpayment's surplus into the ledger.
 *
 * Called right after a payment is verified when net_credit > amount_due.
 *
 * This used to INSERT into customer_credit_ledger directly from the browser,
 * which RLS rejects for every non-admin with 42501 — silently losing the
 * customer's credit. Writes now go through public.record_excess_credit(),
 * which authorizes the caller, serializes per customer, computes the running
 * balance inside the transaction, and is idempotent per booking (so a retried
 * submit cannot credit the same surplus twice).
 */
export const recordExcessCredit = async (customerId, bookingId, amount, note = '') => {
  const value = Number(amount) || 0;
  if (value <= 0) return { recorded: 0 };
  if (!customerId) return { recorded: 0 };

  const { data, error } = await supabase.rpc('record_excess_credit', {
    p_customer_id: customerId,
    p_booking_id: bookingId || null,
    p_amount: value,
    p_note: note || null,
  });

  if (error) {
    logger.error('Failed to record excess credit', error);
    throw new Error('Could not record the overpayment credit. Please contact an administrator.');
  }

  return { recorded: Number(data?.recorded) || 0, balanceAfter: Number(data?.balance_after) || 0, alreadyRecorded: data?.already_recorded };
};

/**
 * Auto-absorb excess_credit against a service downpayment D.
 * Returns { downpayment, credit_available, credit_used, shortfall, balance_after }.
 * The caller prompts ONLY for `shortfall`.
 */
export const applyServiceDownpayment = async (customerId, bookingId, downpayment) => {
  const { data, error } = await supabase.rpc('apply_service_downpayment', {
    p_customer_id: customerId,
    p_booking_id: bookingId,
    p_downpayment: Number(downpayment) || 0,
  });
  if (error) {
    logger.error('apply_service_downpayment failed', error);
    throw new Error(error.message || 'Could not apply available credit. Please try again.');
  }
  return data;
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
  fetchExcessCredit,
  fetchCreditLedger,
  recordExcessCredit,
  applyServiceDownpayment,
  settleOverpaymentOnCompletion,
};