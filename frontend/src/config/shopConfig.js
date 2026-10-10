import { supabase } from '../lib/supabase';
import { setBikeVehicleTypes } from './vehicleTypes';
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
// Active staff accounts (the database's shop_capacity() figure); null until first load.
let technicians = null;
const listeners = new Set();

/** Bays the shop can use at once: the lower of the bays and vehicles-per-technician x technicians. */
const withEffectiveBays = (next) => {
  if (!next) return null;
  const bays = Number(next.slots_per_hour);
  const perTechnician = Number(next.max_vehicles_per_staff);
  if (!Number.isFinite(bays) || bays <= 0) return { ...next, technicians };
  const byStaff = Number.isFinite(perTechnician) && perTechnician > 0 && technicians ? perTechnician * technicians : Infinity;
  return { ...next, technicians, effective_bays: Math.max(1, Math.min(bays, byStaff)) };
};

const applyRow = (incoming) => {
  const next = withEffectiveBays(incoming);
  row = next || null;
  setCatalogSource({
    customServices: Array.isArray(row?.custom_services) ? row.custom_services : [],
    archivedServiceIds: Array.isArray(row?.archived_service_ids) ? row.archived_service_ids : [],
    deletedServiceIds: Array.isArray(row?.deleted_service_ids) ? row.deleted_service_ids : [],
    promoRules: Array.isArray(row?.promo_rules) ? row.promo_rules : [],
    vehicleTypes: Array.isArray(row?.vehicle_types) ? row.vehicle_types : []
  });
  setBikeVehicleTypes(row?.bike_vehicle_types);
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
    const { data: capacity } = await supabase.rpc('shop_capacity');
    if (capacity?.technicians) technicians = Number(capacity.technicians);
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

/** Vehicles bookable per slot (effective capacity). 1 matches the database default. */
export const bayCapacityOf = (config) => {
  const value = Number(config?.effective_bays ?? config?.slots_per_hour);
  return Number.isFinite(value) && value > 0 ? value : 1;
};

export const getBayCapacity = async () => bayCapacityOf(await ensureShopConfig());
