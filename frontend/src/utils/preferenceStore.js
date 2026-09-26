import { supabase } from '../lib/supabase';
import { COMMUNICATION_PREFERENCES } from '../config/legalContent';

/**
 * Communication-preference persistence.
 *
 * Design goals:
 *  - NEVER strand the user if the DB is unavailable or a column is missing.
 *    localStorage is the reliable store; the DB is a best-effort sync so the
 *    preference follows the account across devices when the schema supports it.
 *  - A single read/write surface so all three dashboards behave identically.
 *
 * The values are stored as a flat object keyed by COMMUNICATION_PREFERENCES.key:
 *   { emailBookingUpdates: true, promoEmailSms: false }
 */

const STORAGE_KEY = 'speedway-comm-preferences';

export const getDefaultPreferences = () =>
  COMMUNICATION_PREFERENCES.reduce((acc, pref) => {
    acc[pref.key] = pref.defaultValue;
    return acc;
  }, {});

/** Read local preferences, merged over the defaults (so new keys get a value). */
export const readLocalPreferences = () => {
  const defaults = getDefaultPreferences();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return { ...defaults, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return defaults;
  }
};

/** Persist preferences locally. Always succeeds (worst case the write is a no-op). */
export const writeLocalPreferences = (prefs) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
};

/**
 * Load preferences for a user: local first (instant, offline-safe), then overlay
 * the legacy profile flag. The structured notification_preferences column is
 * optional and is not selected here because older deployed schemas do not have
 * it; requesting one missing PostgREST column makes the whole profile query 400.
 */
export const loadPreferences = async (userId) => {
  const local = readLocalPreferences();
  if (!userId) return local;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('push_notifications_enabled')
      .eq('id', userId)
      .maybeSingle();
    if (error) return local;
    const merged = { ...local };
    // Seed the email flag from the legacy column when the structured store has
    // no opinion yet, so pre-existing accounts keep their previous behaviour.
    if (typeof data?.push_notifications_enabled === 'boolean' && local.emailBookingUpdates === undefined) {
      merged.emailBookingUpdates = data.push_notifications_enabled;
    }
    return merged;
  } catch {
    return local;
  }
};

/**
 * Save preferences for a user. Local write is authoritative and immediate; the
 * profile sync is guarded so a missing column (PGRST204 / 42703 / "does not
 * exist") is treated as success rather than an error the user has to see.
 */
export const savePreferences = async (userId, prefs) => {
  writeLocalPreferences(prefs);
  if (!userId) return { success: true, persisted: false };
  try {
    // Build the profile update. `notification_preferences` is the structured
    // store; `push_notifications_enabled` is the legacy column other screens
    // (Staff notifications, reminder jobs) still read — mirror the email flag
    // into it so the two can never disagree.
    const profileUpdate = { notification_preferences: prefs };
    if (typeof prefs.emailBookingUpdates === 'boolean') {
      profileUpdate.push_notifications_enabled = prefs.emailBookingUpdates;
    }

    const { error } = await supabase
      .from('profiles')
      .update(profileUpdate)
      .eq('id', userId);

    if (error) {
      const soft = error.code === 'PGRST204' || error.code === '42703' || /does not exist/i.test(error.message || '');
      if (soft) {
        // One of the columns is missing — retry with just the legacy flag so at
        // least the notification behaviour still persists.
        if (profileUpdate.push_notifications_enabled !== undefined) {
          const { error: fallbackErr } = await supabase
            .from('profiles')
            .update({ push_notifications_enabled: profileUpdate.push_notifications_enabled })
            .eq('id', userId);
          if (!fallbackErr) return { success: true, persisted: true };
        }
        return { success: true, persisted: false };
      }
      return { success: true, persisted: false, warning: error.message };
    }
    return { success: true, persisted: true };
  } catch (err) {
    return { success: true, persisted: false, warning: err.message };
  }
};