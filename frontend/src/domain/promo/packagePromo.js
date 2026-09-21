/**
 * packagePromo.js
 * Pure domain logic for Package Promos: two or more distinct services bundled
 * for selected vehicle types under an explicit Fixed Package Price.
 *
 * Package Schema = { Name, VehicleTypes[], BundledServices[], PackagePrice, ValidityDates }
 *
 * Pricing Rule (hard business invariant):
 *   PackagePrice < sum(Standalone Service Price_i)
 *
 * All functions are pure; no React, no I/O.
 */
import { MIN_PACKAGE_SERVICES, PROMO_MODE, NEVER_EXPIRES, isNeverExpiring } from './promoTypes';

/**
 * Resolve the standalone (undiscounted) price of a single bundled service for a
 * given vehicle type. Accepts either a precomputed unit price (from the draft's
 * `servicePrices` map) or a resolver callback.
 */
const resolveStandalonePrice = (serviceName, vehicleType, options = {}) => {
  const { servicePrices = {}, resolvePrice } = options;
  if (typeof resolvePrice === 'function') {
    return Number(resolvePrice(serviceName, vehicleType) || 0);
  }
  const byService = servicePrices[serviceName];
  if (byService && typeof byService === 'object') return Number(byService[vehicleType] || 0);
  if (typeof byService === 'number') return byService;
  return 0;
};

/**
 * Sum the standalone prices of every bundled service for one vehicle type.
 * This is the right-hand side of the pricing invariant.
 */
export const standaloneBundledSum = (bundledServices = [], vehicleType, options = {}) =>
  (bundledServices || []).reduce(
    (sum, name) => sum + resolveStandalonePrice(name, vehicleType, options),
    0
  );

/**
 * Sum of standalone prices for the *cheapest* scoped vehicle type. Using the
 * minimum keeps the invariant conservative: if the package is cheaper than the
 * standalone sum for every scoped vehicle type, it is valid.
 */
export const minimumStandaloneSum = (bundledServices = [], vehicleTypes = [], options = {}) => {
  const types = (vehicleTypes || []).length ? vehicleTypes : [undefined];
  const sums = types.map((type) => standaloneBundledSum(bundledServices, type, options));
  return sums.length ? Math.min(...sums) : 0;
};

/** Empty draft used when the admin opens a fresh Package Promo form. */
export const createPackagePromoDraft = (overrides = {}) => ({
  mode: PROMO_MODE.PACKAGE,
  name: 'Weekend Bundle',
  packagePrice: 0,
  validFrom: '2026-09-21T00:00',
  validUntil: '2026-09-30T23:59',
  // Map of vehicleType -> { [serviceName]: serviceName[] }. The bundle for a
  // given vehicle type is defined by the services checked inside its popover.
  vehicleBundles: {},
  vehicleTypes: [],
  neverExpires: false,
  ...overrides,
});

/** Flatten a vehicle's bundle map into the list of bundled service names. */
export const bundledServicesForVehicle = (draft = {}, vehicleType) => {
  const bundle = draft.vehicleBundles?.[vehicleType];
  if (bundle && typeof bundle === 'object') return Object.keys(bundle);
  return [];
};

/** Union of every bundled service across all scoped vehicle types. */
export const allBundledServices = (rawDraft = {}) => {
  const draft = rawDraft && typeof rawDraft === 'object' ? rawDraft : {};
  const names = new Set();
  Object.values(draft.vehicleBundles || {}).forEach((bundle) => {
    Object.keys(bundle || {}).forEach((name) => names.add(name));
  });
  return [...names];
};

/**
 * Validate a Package Promo draft against the full spec lock-engine rules.
 * Returns { valid, locked, errors, minimumStandalone } where `locked` mirrors
 * the CONFIRM PACKAGE disabled state.
 */
export const validatePackagePromo = (rawDraft = {}, options = {}) => {
  // Defensive: an explicit null (e.g. a cleared draft flowing through the lock
  // engine) must degrade to "everything invalid" rather than throwing.
  const draft = rawDraft && typeof rawDraft === 'object' ? rawDraft : {};
  const errors = [];
  const vehicleTypes = draft.vehicleTypes || [];
  const bundled = allBundledServices(draft);
  const packagePrice = Number(draft.packagePrice || 0);

  if (!String(draft.name || '').trim()) errors.push('Please enter a package name.');

  // Rule: minimum two (2) distinct services.
  const perVehicleCounts = Object.entries(draft.vehicleBundles || {}).map(([type, bundle]) => ({
    type,
    count: Object.keys(bundle || {}).length,
  }));
  const underfilled = perVehicleCounts.filter((entry) => entry.count > 0 && entry.count < MIN_PACKAGE_SERVICES);
  if (bundled.length < MIN_PACKAGE_SERVICES) {
    errors.push(`Select at least ${MIN_PACKAGE_SERVICES} services to form a package bundle.`);
  } else if (underfilled.length) {
    errors.push(`Each vehicle type needs at least ${MIN_PACKAGE_SERVICES} bundled services.`);
  }

  // Rule: PackagePrice > 0 and < sum of selected standalone services.
  const minimumStandalone = minimumStandaloneSum(bundled, vehicleTypes, options);
  if (packagePrice <= 0) {
    errors.push('Enter a fixed package price greater than 0.');
  } else if (minimumStandalone > 0 && packagePrice >= minimumStandalone) {
    errors.push(
      `Package price must be lower than the standalone total (\u20B1${minimumStandalone.toLocaleString()}).`
    );
  }

  // Rule: required date parameters populated.
  if (!draft.validFrom || !draft.validUntil) errors.push('Please set both valid dates.');
  if (!draft.neverExpires && draft.validFrom && draft.validUntil && new Date(draft.validUntil) <= new Date(draft.validFrom)) {
    errors.push('Valid Until must be later than Valid From.');
  }

  // Rule: at least one vehicle type and one service selected.
  if (!vehicleTypes.length) errors.push('Please select at least 1 vehicle type.');
  if (!bundled.length) errors.push('Please select at least 1 service.');

  return {
    valid: errors.length === 0,
    locked: errors.length > 0,
    errors,
    minimumStandalone,
    bundleCount: bundled.length,
  };
};

/** Serialize a validated Package Promo draft into a persistable rule. */
export const packageDraftToRule = (draft, existingId = null, options = {}) => {
  const vehicleTypes = draft.vehicleTypes || [];
  const bundledServices = allBundledServices(draft);
  return {
    id: existingId || `package-${Date.now()}`,
    mode: PROMO_MODE.PACKAGE,
    name: String(draft.name || '').trim(),
    packagePrice: Number(draft.packagePrice || 0),
    vehicleTypes,
    bundledServices,
    vehicleBundles: draft.vehicleBundles || {},
    standaloneSum: minimumStandaloneSum(bundledServices, vehicleTypes, options),
    validFrom: draft.validFrom,
    // Never Expires persists as JSON null so DB date filters never cast 'never'.
    validUntil: draft.neverExpires ? NEVER_EXPIRES : draft.validUntil,
    isOngoing: true,
    active: true,
    neverExpires: Boolean(draft.neverExpires),
  };
};

/** Hydrate a persisted package rule back into an editable draft. */
export const packageRuleToDraft = (rule = {}) => {
  let vehicleBundles = rule.vehicleBundles;
  if (!vehicleBundles || !Object.keys(vehicleBundles).length) {
    // Rebuild a symmetric bundle map from the persisted flat service list so
    // legacy / hand-authored rules remain editable.
    vehicleBundles = {};
    (rule.vehicleTypes || []).forEach((type) => {
      vehicleBundles[type] = {};
      (rule.bundledServices || []).forEach((name) => { vehicleBundles[type][name] = true; });
    });
  }
  return createPackagePromoDraft({
    name: rule.name ?? '',
    packagePrice: rule.packagePrice ?? 0,
    validFrom: rule.validFrom || '2026-09-21T00:00',
    validUntil: isNeverExpiring(rule.validUntil) ? '2026-09-30T23:59' : rule.validUntil,
    vehicleTypes: rule.vehicleTypes || [],
    vehicleBundles,
    neverExpires: Boolean(rule.neverExpires),
  });
};

/** Describe a package rule for the rule list UI. */
export const describePackage = (rule = {}) =>
  `\u20B1${Number(rule.packagePrice || 0).toLocaleString()} BUNDLE`;
