/**
 * promoService.js
 * Persistence layer for promo rules.
 *
 * Centralized Supabase persistence (business_config.promo_rules) is the source
 * of truth so the customer portal and admin manual booking stay in sync.
 * localStorage is retained only as an offline fallback cache.
 */
import { supabase } from '../lib/supabase';
import { isPromoActiveForNow } from '../data/servicesCatalog';
import { PROMO_STORAGE_KEY } from '../domain/promo/promoTypes';
import { logger } from '../utils/logger';

const readCache = () => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(PROMO_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeCache = (rules) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify(rules));
  } catch {
    /* quota / private mode — cache is best-effort only */
  }
};

/**
 * Fetch all promo rules from Supabase, falling back to the local cache when the
 * network or table is unavailable. Always refreshes the cache on success.
 */
export const fetchPromoRules = async () => {
  try {
    const { data, error } = await supabase
      .from('business_config')
      .select('promo_rules')
      .maybeSingle();

    if (error) throw error;
    const rules = Array.isArray(data?.promo_rules) ? data.promo_rules : [];
    writeCache(rules);
    return rules;
  } catch (err) {
    logger.warn('Promo fetch fell back to local cache.', err);
    return readCache();
  }
};

/**
 * Persist the full promo rule list to Supabase (and mirror to the local cache).
 * Prefers the admin-only `set_promo_rules` RPC (atomic, array-validated) and
 * falls back to a direct upsert when the RPC is not deployed.
 * Returns the saved list so callers can update state from the authoritative copy.
 */
export const savePromoRules = async (rules) => {
  const nextRules = Array.isArray(rules) ? rules : [];

  const { data: rpcData, error: rpcError } = await supabase.rpc('set_promo_rules', { p_rules: nextRules });
  if (!rpcError) {
    const saved = Array.isArray(rpcData) ? rpcData : nextRules;
    writeCache(saved);
    return saved;
  }

  // Fallback path: direct upsert (relies on business_config admin-only RLS).
  const { error } = await supabase.from('business_config').upsert({
    id: 1,
    promo_rules: nextRules,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    logger.error('Promo persistence failed', error);
    throw error;
  }
  writeCache(nextRules);
  return nextRules;
};

/**
 * Insert or update a single rule by id and persist the resulting list.
 */
export const upsertPromoRule = async (rule, existingRules = []) => {
  const exists = existingRules.some((item) => item.id === rule.id);
  const nextRules = exists
    ? existingRules.map((item) => (item.id === rule.id ? rule : item))
    : [rule, ...existingRules];
  return savePromoRules(nextRules);
};

/**
 * Deactivate (soft-delete) a rule so pending checkout sessions immediately stop
 * offering it, while the historical record is preserved.
 */
export const deactivatePromoRule = async (ruleId, existingRules = []) => {
  const nextRules = existingRules.map((item) =>
    item.id === ruleId ? { ...item, active: false, isOngoing: false, deactivatedAt: new Date().toISOString() } : item
  );
  return savePromoRules(nextRules);
};

/** Hard-delete a rule from persistence. */
export const removePromoRule = async (ruleId, existingRules = []) => {
  const nextRules = existingRules.filter((item) => item.id !== ruleId);
  return savePromoRules(nextRules);
};

/** Read the local cache without a network round-trip (offline fallback). */
export const getCachedPromoRules = () => readCache();

/** Re-exported for consumers that only need the active/validity predicate. */
export { isPromoActiveForNow };
