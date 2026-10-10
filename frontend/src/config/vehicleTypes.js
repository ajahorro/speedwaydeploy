import { VEHICLE_TYPE_OPTIONS } from './constants';

/**
 * THE one definition of "which vehicle categories does this shop service".
 *
 * Source of truth: business_config.vehicle_types, written only by the Business
 * Hub. Everything that shows or lets someone pick a vehicle category (the
 * booking wizard, the customer garage, promos, promo codes, the Hub itself)
 * must get its list from here, normally through useConfig().settings
 * (VEHICLE_TYPES / VEHICLE_TYPE_KEYS), so a category the admin adds in the Hub
 * shows up everywhere at once. Do not import VEHICLE_TYPE_OPTIONS / _KEYS from
 * constants.js in a component: that list is only the built-in starting set
 * (scripts/verify-single-source.mjs enforces this).
 *
 * Rule: the built-in categories are always present, in their canonical order;
 * categories the Hub added follow, in the order they were added. The Hub never
 * lets an admin remove a built-in, so this matches what the Hub itself shows.
 *
 * This is a leaf module (it imports only constants.js) so any layer can use it
 * without creating an import cycle.
 *
 * @param {unknown} configured business_config.vehicle_types (may be null or hold junk)
 * @returns {{ value: string, label: string }[]}
 */
export const resolveVehicleTypeOptions = (configured) => {
  const seen = new Set(VEHICLE_TYPE_OPTIONS.map((option) => option.value.toLowerCase()));
  const added = [];
  (Array.isArray(configured) ? configured : []).forEach((raw) => {
    const type = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!type || seen.has(type.toLowerCase())) return;
    seen.add(type.toLowerCase());
    added.push({ value: type, label: type });
  });
  return [...VEHICLE_TYPE_OPTIONS, ...added];
};

/** The price-list keys of resolveVehicleTypeOptions(configured), in the same order. */
export const resolveVehicleTypeKeys = (configured) => resolveVehicleTypeOptions(configured).map((option) => option.value);
