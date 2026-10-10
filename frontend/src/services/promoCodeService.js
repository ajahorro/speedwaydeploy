import { supabase } from '../lib/supabase';

/**
 * Promo codes are redeemed one at a time through redeem_promo_code(): the
 * database answers whether the code is valid right now and, if so, which
 * promotion it unlocks. The list of codes is never sent to the browser.
 */

const MESSAGES = {
  empty: 'Enter a promo code.',
  not_found: 'That promo code is not valid.',
  not_started: 'That promo code is not active yet.',
  expired: 'That promo code has expired.',
  used_up: 'That promo code has reached its limit.',
  already_used: 'This account has already used that promo code.',
  sign_in: 'Sign in to use a promo code.'
};

/** @returns {Promise<{ valid: true, rule: object } | { valid: false, reason: string, message: string }>} */
export const redeemPromoCode = async (code, customerId = null) => {
  const trimmed = String(code || '').trim();
  if (!trimmed) return { valid: false, reason: 'empty', message: MESSAGES.empty };

  const { data, error } = await supabase.rpc('redeem_promo_code', { p_code: trimmed, p_customer_id: customerId || null });
  if (error) {
    return { valid: false, reason: 'error', message: 'We could not check that code right now. Please try again.' };
  }
  if (data?.valid && data.rule) return { valid: true, rule: data.rule };
  const reason = data?.reason || 'not_found';
  return { valid: false, reason, message: MESSAGES[reason] || MESSAGES.not_found };
};
