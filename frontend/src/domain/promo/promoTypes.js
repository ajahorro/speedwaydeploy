/**
 * promoTypes.js
 * Canonical, framework-agnostic constants describing the two promo modes.
 * Kept dependency-free so both the domain layer and the pricing engine can
 * share a single vocabulary (no magic strings scattered across the app).
 */

/** Promo mode discriminator stored on every rule. */
export const PROMO_MODE = Object.freeze({
  STANDARD: 'standard',
  PACKAGE: 'package',
});

/** Standard promo discount models. */
export const DISCOUNT_TYPE = Object.freeze({
  PERCENTAGE: 'percentage',
  FIXED: 'fixed',
});

/**
 * Minimum number of bundled services required to form a valid Package Promo.
 * Mirrors the specification: Count(BundledServices) >= 2.
 */
export const MIN_PACKAGE_SERVICES = 2;

/** Vehicle types an admin can scope a promo to. */
export const PROMO_VEHICLE_OPTIONS = Object.freeze(['Sedan', 'SUV', 'Truck', 'Luxury']);

/** Standalone services an admin can match / bundle. */
export const PROMO_SERVICE_OPTIONS = Object.freeze([
  'Interior Detail',
  'Full Detail',
  'Paint Correction',
  'Express Wash',
]);

/** Shared localStorage key used as an offline fallback cache for promo rules. */
export const PROMO_STORAGE_KEY = 'speedway_promo_rules';

/**
 * Sentinel persisted for "Never Expires" rules.
 *
 * Stored as JSON null (not the string 'never') so downstream SQL date filters
 * and `jsonb` comparisons receive a genuine null rather than a value that fails
 * a ::timestamptz cast. Legacy rules persisted with the old 'never' string are
 * still tolerated on read by `isNeverExpiring`.
 */
export const NEVER_EXPIRES = null;

/**
 * Whether a persisted valid-until value means "no expiry".
 * Accepts null/undefined/'' (current) and the legacy 'never' string.
 */
export const isNeverExpiring = (validUntil) =>
  validUntil === null || validUntil === undefined || validUntil === '' || validUntil === 'never';
