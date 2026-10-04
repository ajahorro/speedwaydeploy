import { supabase } from '../lib/supabase';
import { setCatalogSource } from '../data/servicesCatalog';
import { setDownpaymentPolicy } from '../utils/paymentUtils';

/**
 * The ONE reader of public.business_config in the browser.
 *
 * The Business Hub writes the shop configuration row; every booking screen,
 * the service catalog, promo pricing and the downpayment policy read it from
 * here. ConfigContext keeps it fresh (realtime + window focus), so there is no
 * localStorage copy that can go stale and no component querying the table on
 * its own with a different fallback.
 *
 * business_config is a singleton: the lowest id row, the same row every SQL
 * function reads (shop_downpayment_policy, booking_schedule_violation, ...).
 */

let row = null;
let inflight = null;
const listeners = new Set();

const applyRow = (next) => {
  row = next || null;
  setCatalogSource({
    customServices: Array.isArray(row?.custom_services) ? row.custom_services : [],
    archivedServiceIds: Array.isArray(row?.archived_service_ids) ? row.archived_service_ids : [],
    deletedServiceIds: Array.isArray(row?.deleted_service_ids) ? row.deleted_service_ids : [],
    promoRules: Array.isArray(row?.promo_rules) ? row.promo_rules : [],
    vehicleTypes: Array.isArray(row?.vehicle_types) ? row.vehicle_types : []
  });
  setDownpaymentPolicy({
    min_total: row?.downpayment_min_total,
    rate: row?.downpayment_rate,
    high_threshold: row?.downpayment_high_threshold,
    high_rate: row?.downpayment_high_rate
  });
  listeners.forEach((listener) => {
    try { listener(row); } catch { /* a listener must not break the others */ }
  });
};

/** Load (or reload with force) the shop configuration row. */
export const fetchShopConfig = async ({ force = false } = {}) => {
  if (row && !force) return row;
  if (inflight) return inflight;
  inflight = (async () => {
    const { data, error } = await supabase
      .from('business_config')
      .select('*')
      .order('id')
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    applyRow(data);
    return row;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
};

/** The loaded row, or null before the first load. */
export const getShopConfig = () => row;

/** Resolve the row, loading it once if needed. */
export const ensureShopConfig = () => (row ? Promise.resolve(row) : fetchShopConfig());

/** Optimistically apply a row the Business Hub just saved (no round trip). */
export const applyShopConfig = (nextRow) => applyRow(nextRow);

export const subscribeShopConfig = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Bays bookable per slot. 1 matches the database capacity default. */
export const bayCapacityOf = (config) => {
  const value = Number(config?.slots_per_hour);
  return Number.isFinite(value) && value > 0 ? value : 1;
};

export const getBayCapacity = async () => bayCapacityOf(await ensureShopConfig());
