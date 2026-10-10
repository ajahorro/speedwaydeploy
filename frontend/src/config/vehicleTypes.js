import { VEHICLE_TYPE_OPTIONS } from './constants.js';

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

const VEHICLE_ALIASES = {
  hatch: 'Hatch',
  hatchback: 'Hatch',
  'hatch back': 'Hatch',
  sedan: 'Sedan',
  'sedan hatchback': 'Sedan',
  auv: 'AUV',
  mpv: 'AUV',
  crossover: 'AUV',
  'auv mpv crossover': 'AUV',
  suv: 'SUV',
  'suv crossover': 'SUV',
  pickup: 'Pickup',
  'pick up': 'Pickup',
  'van small': 'Van Small',
  'van medium': 'Van Medium',
  'van large': 'Van Large',
  van: 'Van Medium',
  'van l300': 'Van Medium',
  'pickup van': 'Van Medium',
  regular: 'Regular',
  motorcycle: 'Regular',
  'motorcycle regular': 'Regular',
  moto: 'Regular',
  bigbike: 'Bigbike',
  'big bike': 'Bigbike'
};

// "vanl300" / "bigbike" style spellings: the aliases with their spaces removed.
const VEHICLE_ALIASES_NO_SPACES = Object.fromEntries(Object.entries(VEHICLE_ALIASES).map(([k, v]) => [k.replace(/ /g, ''), v]));

const flatVehicleText = (text) => String(text).toLowerCase().replace(/[_/()-]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * THE one "what vehicle category is this text?" rule: maps a category key, a
 * label ("Van (Small)"), or a legacy / free-text name ("SUV/Crossover", "moto",
 * "Van L300") to the canonical category key used by the price list. Text that
 * matches nothing is returned unchanged (a custom Hub category is its own key).
 *
 * The database keeps one SQL copy of the alias list (catalog_vehicle_key);
 * scripts/verify-catalog-sync.mjs fails if the two disagree.
 */
export const canonicalVehicleKey = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const flat = flatVehicleText(raw);
  const exact = VEHICLE_TYPE_OPTIONS.find((option) => flatVehicleText(option.value) === flat || flatVehicleText(option.label) === flat);
  if (exact) return exact.value;
  const normalized = raw.toLowerCase().replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return VEHICLE_ALIASES[normalized] || VEHICLE_ALIASES_NO_SPACES[normalized.replace(/\s+/g, '')] || raw;
};
