/**
 * standardPromo.js
 * Pure domain logic for Standard Promos: a percentage or fixed discount
 * applied to individual services for matched vehicle types and services.
 *
 * Every function here is a pure function (no React, no I/O) so the logic is
 * trivial to unit test and cannot entangle with UI state (SRP).
 */
import { DISCOUNT_TYPE, PROMO_MODE, NEVER_EXPIRES, isNeverExpiring } from './promoTypes';

/** Empty draft used when the admin opens a fresh Standard Promo form. */
export const createStandardPromoDraft = (overrides = {}) => ({
  mode: PROMO_MODE.STANDARD,
  name: 'Weekend Special',
  type: DISCOUNT_TYPE.PERCENTAGE,
  value: 10,
  validFrom: '2026-09-21T00:00',
  validUntil: '2026-09-30T23:59',
  vehicleTypes: ['Sedan', 'SUV'],
  serviceMatches: ['Interior Detail', 'Full Detail'],
  neverExpires: false,
  ...overrides,
});

/** Hydrate a persisted rule back into an editable draft. */
export const standardRuleToDraft = (rule = {}) => createStandardPromoDraft({
  name: rule.name ?? '',
  type: rule.type ?? DISCOUNT_TYPE.PERCENTAGE,
  value: rule.value ?? 0,
  validFrom: rule.validFrom || '2026-09-21T00:00',
  validUntil: isNeverExpiring(rule.validUntil) ? '2026-09-30T23:59' : rule.validUntil,
  vehicleTypes: rule.vehicleTypes || [],
  serviceMatches: rule.serviceMatches || [],
  neverExpires: Boolean(rule.neverExpires),
});

/**
 * Validate a Standard Promo draft.
 * Returns { valid, errors } where errors is an ordered list of messages.
 */
export const validateStandardPromo = (rawDraft = {}) => {
  // Defensive: an explicit null must degrade to "everything invalid", not throw.
  const draft = rawDraft && typeof rawDraft === 'object' ? rawDraft : {};
  const errors = [];
  if (!String(draft.name || '').trim()) errors.push('Please enter a promo name.');
  if (!draft.value || Number(draft.value) <= 0) errors.push('Please enter a valid discount value.');
  if (!draft.validFrom || !draft.validUntil) errors.push('Please set both valid dates.');
  if (!draft.neverExpires && draft.validFrom && draft.validUntil && new Date(draft.validUntil) <= new Date(draft.validFrom)) {
    errors.push('Valid Until must be later than Valid From.');
  }
  if (!(draft.vehicleTypes || []).length || !(draft.serviceMatches || []).length) {
    errors.push('Please select at least 1 vehicle type and service.');
  }
  return { valid: errors.length === 0, errors };
};

/** Serialize a validated draft into a persistable rule. */
export const standardDraftToRule = (draft, existingId = null) => ({
  id: existingId || `promo-${Date.now()}`,
  mode: PROMO_MODE.STANDARD,
  name: String(draft.name || '').trim(),
  type: draft.type,
  value: Number(draft.value),
  validFrom: draft.validFrom,
  // Never Expires persists as JSON null so DB date filters never cast 'never'.
  validUntil: draft.neverExpires ? NEVER_EXPIRES : draft.validUntil,
  vehicleTypes: draft.vehicleTypes,
  serviceMatches: draft.serviceMatches,
  isOngoing: true,
  active: true,
  neverExpires: Boolean(draft.neverExpires),
});

/** Compute a discounted price for a single service given matching rules. */
export const applyStandardDiscount = (price, rules = []) => {
  let adjusted = Number(price || 0);
  (rules || []).forEach((rule) => {
    if (rule.type === DISCOUNT_TYPE.PERCENTAGE) {
      adjusted = adjusted * (1 - (Number(rule.value || 0) / 100));
    } else if (rule.type === DISCOUNT_TYPE.FIXED) {
      adjusted = Math.max(0, adjusted - Number(rule.value || 0));
    }
  });
  return Math.round(adjusted * 100) / 100;
};

/** Human-readable summary of a standard rule's discount (used by the rule list). */
export const describeStandardDiscount = (rule = {}) =>
  rule.type === DISCOUNT_TYPE.PERCENTAGE
    ? `${rule.value}% OFF`
    : `\u20B1${Number(rule.value || 0).toLocaleString()} OFF`;
