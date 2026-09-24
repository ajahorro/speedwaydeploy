import { supabase } from '../lib/supabase';
import { readLocalPreferences } from '../utils/preferenceStore';

/**
 * customerNotifyService.js
 * ============================================================================
 * Preference-gated dispatch helpers for customer-facing announcements.
 *
 * The brief requires that the marketing/announcement emails — new promos, new
 * services, and new vehicle categories — are sent ONLY to customers who have
 * explicitly opted in via their notification settings. This module is the single
 * gate every caller checks before sending such an email, so the rule can never
 * drift between the different announcement paths.
 *
 * Preference keys (see COMMUNICATION_PREFERENCES in config/legalContent.js):
 *   emailNewPromos    -> a new promotion / discount went live
 *   emailNewServices  -> a new service was added to the catalog
 *   emailNewVehicles  -> a new vehicle category is now serviced
 *
 * Default is OPT-OUT (false): nothing is sent unless the customer turned the
 * matching switch ON, matching "only trigger if the customer has their settings
 * explicitly configured this way".
 */

export const NOTIFY_CATEGORIES = Object.freeze({
  PROMO: 'emailNewPromos',
  SERVICE: 'emailNewServices',
  VEHICLE: 'emailNewVehicles',
});

const PREFERENCE_KEY_BY_CATEGORY = {
  promo: NOTIFY_CATEGORIES.PROMO,
  service: NOTIFY_CATEGORIES.SERVICE,
  vehicle: NOTIFY_CATEGORIES.VEHICLE,
};

/**
 * Read a customer's notification preferences (DB first, local fallback).
 * @param {string} userId
 * @returns {Promise<object>}
 */
export const getCustomerNotificationPreferences = async (userId) => {
  const local = readLocalPreferences();
  if (!userId) return local;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('notification_preferences')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data?.notification_preferences) return local;
    return { ...local, ...data.notification_preferences };
  } catch {
    return local;
  }
};

/**
 * Should this customer receive an announcement of the given category?
 * Fails CLOSED: any missing/unknown preference, or a lookup error, means NO send.
 *
 * @param {string} userId
 * @param {'promo'|'service'|'vehicle'} category
 * @returns {Promise<boolean>}
 */
export const shouldNotifyCustomer = async (userId, category) => {
  const key = PREFERENCE_KEY_BY_CATEGORY[category];
  if (!key) return false; // unknown category never sends
  const prefs = await getCustomerNotificationPreferences(userId);
  return prefs[key] === true;
};

/**
 * Filter a list of customer ids down to those who opted into `category`.
 * @param {string[]} userIds
 * @param {'promo'|'service'|'vehicle'} category
 * @returns {Promise<string[]>}
 */
export const filterOptedInCustomers = async (userIds = [], category) => {
  const key = PREFERENCE_KEY_BY_CATEGORY[category];
  if (!key || !userIds.length) return [];
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, notification_preferences')
      .in('id', userIds);
    if (error || !Array.isArray(data)) return [];
    return data
      .filter((p) => p?.notification_preferences && p.notification_preferences[key] === true)
      .map((p) => p.id);
  } catch {
    return [];
  }
};

export default { shouldNotifyCustomer, filterOptedInCustomers, getCustomerNotificationPreferences, NOTIFY_CATEGORIES };