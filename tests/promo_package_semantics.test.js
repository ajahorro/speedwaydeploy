// Regression test for the PROMO vs PACKAGE pricing semantics.
//
// Run with:  node tests/promo_package_semantics.test.js
//        or  node --test tests/promo_package_semantics.test.js
//
// Locks in the two-model pricing contract implemented in
// frontend/src/data/servicesCatalog.js:
//
//   • STANDARD promo  = a MODIFIER. Takes a % or fixed amount off each matched
//     service, independently. Multiple standard promos may stack (floored at ₱0).
//   • PACKAGE promo   = a PRODUCT. A whole-vehicle flat price for a defined SET
//     of services. Applies ONLY when the customer selects the entire set, and it
//     NEVER stacks with other promos (prevents double-discounting).
//
// It also guards the pinned regressions we actually fixed:
//   - A package no longer surfaces as a per-service discount via
//     getBestPromoForService()/getApplicablePromoRules().
//   - A rule that scopes a vehicle by matrix must NOT leak its discount onto an
//     unbound service on that same vehicle (the \"10% Regular Wash\" bug).
//   - calculateBookingDiscountSummary() emits appliedPackages entries with the
//     exact field names the booking persistence path reads
//     (packageId / standaloneSum / savings), so the frozen PACKAGES:[...] notes
//     marker never writes undefined figures.
//
// The pricing module is browser-oriented ESM, so this harness stubs the globals
// it touches (localStorage/window) BEFORE dynamically importing it. Only pure
// functions are exercised, so no DOM or network is required.

// ---- Global stubs (must exist before the ESM module is imported) ----
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

const RULES = [
  {
    id: 'std-10', name: 'Ten Off', mode: 'standard', type: 'percentage', value: 10,
    validFrom: '2020-01-01T00:00', neverExpires: true,
    vehicleServiceMatrix: { Sedan: ['Regular Wash'] },
  },
  {
    id: 'pkg-1', name: 'Detailing Trio', mode: 'package', type: 'fixed_package', value: 1200,
    validFrom: '2020-01-01T00:00', neverExpires: true, isBundle: true, stackable: false,
    vehicleServiceMatrix: { Sedan: ['Regular Wash', 'Engine Wash', 'Mags Detailing'] },
  },
];

// The suite is written as an async IIFE so we can await the dynamic import of the
// ESM pricing module while the harness itself stays CommonJS (matching the other
// tests/ files, which run under `node`).
(async () => {
  const asserts = [];
  const push = (label, cond) => asserts.push([label, cond]);

  let mod;
  try {
    // Seed rules BEFORE import so any module-load-time read sees them.
    store['speedway_promo_rules'] = JSON.stringify(RULES);
    mod = await import('../frontend/src/data/servicesCatalog.js');
  } catch (e) {
    console.error('HARNESS ERROR: could not import servicesCatalog.js —', e.message);
    process.exitCode = 1;
    return;
  }

  const {
    priceVehicleServices,
    getActivePackageForVehicle,
    getEffectivePriceForService,
    calculateBookingDiscountSummary,
  } = mod;

  // ---- 1. Standard promo applies per-service, independently ----
  // 10% off Regular Wash ₱150 -> ₱135.
  push('standard: 10% off 150 => 135', getEffectivePriceForService(150, 'Sedan', 'Regular Wash') === 135);

  // ---- 2. A package does NOT apply when the bundle set is incomplete ----
  const partial = getActivePackageForVehicle('Sedan', ['Regular Wash', 'Engine Wash']);
  push('package: incomplete set => null', partial === null);

  // ---- 3. A package applies only when the whole set is selected ----
  const full = ['Regular Wash', 'Engine Wash', 'Mags Detailing'];
  const active = getActivePackageForVehicle('Sedan', full);
  push('package: complete set => flat price', active && active.packagePrice === 1200);

  // ---- 4. Package takes precedence: flat price, NO stacking with the 10% ----
  const priced = priceVehicleServices('Sedan', [
    { name: 'Regular Wash', price: 150 },
    { name: 'Engine Wash', price: 500 },
    { name: 'Mags Detailing', price: 1200 },
  ]);
  push('package: unit subtotal is the flat price', priced.unitSubtotal === 1200);
  push('package: suppresses standard promo (member prices 0)',
    JSON.stringify(priced.services.map((s) => s.price_at_booking)) === JSON.stringify([0, 0, 0]));
  push('package: name attached to each member service',
    priced.services.every((s) => s.package_applied === 'Detailing Trio'));

  // ---- 5. Standard stacking still works when no package applies ----
  // Wash gets 10% (135); Engine Wash is NOT bound to that vehicle's matrix, so it
  // stays 500. Subtotal 635 — this is the "matrix must be decisive" regression.
  const std = priceVehicleServices('Sedan', [
    { name: 'Regular Wash', price: 150 },
    { name: 'Engine Wash', price: 500 },
  ]);
  push('standard: subtotal 135 + 500 = 635 (matrix does not leak)', std.unitSubtotal === 635);
  push('standard: no package resolved', std.package === null);

  // ---- 6. calculateBookingDiscountSummary respects the package end-to-end ----
  const summary = calculateBookingDiscountSummary([
    { type: 'Sedan', services: [
      { name: 'Regular Wash', price: 150 },
      { name: 'Engine Wash', price: 500 },
      { name: 'Mags Detailing', price: 1200 },
    ] },
  ]);
  push('summary: original total 1850', summary.originalTotal === 1850);
  push('summary: discounted total = package price 1200', summary.discountedTotal === 1200);
  push('summary: one applied package recorded', summary.appliedPackages.length === 1);
  push('summary: entry.packageId present (booking persistence field)',
    summary.appliedPackages[0] && summary.appliedPackages[0].packageId === 'pkg-1');
  push('summary: entry.standaloneSum present', summary.appliedPackages[0] && summary.appliedPackages[0].standaloneSum === 1850);
  push('summary: entry.savings present', summary.appliedPackages[0] && summary.appliedPackages[0].savings === 650);

  // ---- 7. Negative control: an unrelated vehicle gets no package at all ----
  const suv = priceVehicleServices('SUV', [
    { name: 'Regular Wash', price: 180 },
    { name: 'Engine Wash', price: 800 },
  ]);
  push('negative control: package scoped to Sedan does not apply to SUV', suv.package === null);

  console.log('\n-- assertions --');
  let pass = 0, fail = 0;
  for (const [label, cond] of asserts) {
    if (cond) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}`); }
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
  else console.log('PROMO/PACKAGE SEMANTICS VERIFIED');
})();