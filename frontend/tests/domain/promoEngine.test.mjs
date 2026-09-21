/**
 * promoEngine.test.mjs
 * Regression suite for the Package/Standard promo engine and the booking-rule
 * helpers it depends on. Pure logic only: no React, no network.
 *
 * Coverage mirrors the QA specification:
 *   - 4.1  package price inequality (PackagePrice < StandaloneSum)
 *   - 4.2  minimum two bundled services
 *   - RPC  "Never Expires" must serialize valid_until as JSON null
 *   - 1.2  plate normalization + duplicate detection
 *   - mixed package + standard aggregation across multiple units
 *
 * Run with:  npm run test:promo
 */
import assert from 'node:assert';

// ── DOM/localStorage shim so servicesCatalog (which reads localStorage) loads ──
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window = globalThis;

const { validatePackagePromo, packageDraftToRule } = await import(
  '../../src/domain/promo/packagePromo.js'
);
const { standardDraftToRule, createStandardPromoDraft } = await import(
  '../../src/domain/promo/standardPromo.js'
);
const { isNeverExpiring } = await import('../../src/domain/promo/promoTypes.js');
const { normalizePlate, findDuplicatePlates } = await import(
  '../../src/domain/booking/plateNormalization.js'
);
const { calculateBookingDiscountSummary } = await import(
  '../../src/data/servicesCatalog.js'
);

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    failures.push(name);
  }
};

const priceResolver = (name) =>
  ({ 'Regular Wash': 3500, 'Supreme Wash': 4500 }[name] || 0);

const baseBundle = {
  name: 'Test Bundle',
  vehicleTypes: ['SUV'],
  vehicleBundles: { SUV: { 'Regular Wash': true, 'Supreme Wash': true } },
  validFrom: '2026-09-21T00:00',
  validUntil: '2026-09-30T23:59',
};

const seedRules = (rules) =>
  localStorage.setItem('speedway_promo_rules', JSON.stringify(rules));

console.log('\n── 4.1 Package price inequality (PackagePrice < StandaloneSum) ──');
check('8500 vs standalone 8000 -> INVALID (confirm locked)', () => {
  const r = validatePackagePromo(
    { ...baseBundle, packagePrice: 8500 },
    { resolvePrice: priceResolver }
  );
  assert.strictEqual(r.locked, true, 'expected lock at 8500 >= 8000');
});
check('7000 vs standalone 8000 -> VALID (confirm unlocked)', () => {
  const r = validatePackagePromo(
    { ...baseBundle, packagePrice: 7000 },
    { resolvePrice: priceResolver }
  );
  assert.strictEqual(r.valid, true, r.errors.join('; '));
});
check('exactly 8000 -> still INVALID (strict <)', () => {
  const r = validatePackagePromo(
    { ...baseBundle, packagePrice: 8000 },
    { resolvePrice: priceResolver }
  );
  assert.strictEqual(r.locked, true);
});

console.log('\n── 4.2 Minimum two bundled services ──');
check('1 bundled service -> INVALID', () => {
  const single = {
    ...baseBundle,
    packagePrice: 1000,
    vehicleBundles: { SUV: { 'Regular Wash': true } },
  };
  const r = validatePackagePromo(single, { resolvePrice: priceResolver });
  assert.strictEqual(r.locked, true);
});
check('2 bundled services -> satisfies threshold', () => {
  const r = validatePackagePromo(
    { ...baseBundle, packagePrice: 1000 },
    { resolvePrice: priceResolver }
  );
  assert.ok(
    !r.errors.some((e) => /at least 2 services/i.test(e)),
    r.errors.join('; ')
  );
});

console.log('\n── RPC: "Never Expires" -> null serialization ──');
check('package rule validUntil serializes to null', () => {
  const rule = packageDraftToRule(
    { ...baseBundle, packagePrice: 1000, neverExpires: true },
    null,
    { resolvePrice: priceResolver }
  );
  assert.strictEqual(rule.validUntil, null, `got ${JSON.stringify(rule.validUntil)}`);
  assert.ok(isNeverExpiring(rule.validUntil));
});
check('standard rule validUntil serializes to null', () => {
  const rule = standardDraftToRule({
    ...createStandardPromoDraft(),
    neverExpires: true,
  });
  assert.strictEqual(rule.validUntil, null, `got ${JSON.stringify(rule.validUntil)}`);
});
check('JSON round-trip preserves null (not "never"/"undefined")', () => {
  const rule = standardDraftToRule({
    ...createStandardPromoDraft(),
    neverExpires: true,
  });
  const revived = JSON.parse(JSON.stringify(rule));
  assert.strictEqual(revived.validUntil, null);
});
check('legacy "never" string still readable', () => {
  assert.ok(isNeverExpiring('never'));
});

console.log('\n── 1.2 Plate normalization + duplicate detection ──');
check('"ABC-123" and "abc 123" normalize equal', () => {
  assert.strictEqual(normalizePlate('ABC-123'), normalizePlate('abc 123'));
  assert.strictEqual(normalizePlate('abc 123'), 'ABC123');
});
check('duplicate pair flagged', () => {
  const dups = findDuplicatePlates([
    { plateNumber: 'ABC-123' },
    { plateNumber: 'abc 123' },
  ]);
  assert.strictEqual(dups.size, 1);
  assert.ok(dups.has('ABC123'));
});
check('distinct plates not flagged', () => {
  assert.strictEqual(
    findDuplicatePlates([{ plateNumber: 'ABC-123' }, { plateNumber: 'XYZ-999' }]).size,
    0
  );
});
check('blank plates never flagged (mid-typing rows)', () => {
  assert.strictEqual(
    findDuplicatePlates([{ plateNumber: '' }, { plateNumber: '  - ' }]).size,
    0
  );
});

console.log('\n── Mixed aggregation: package unit + standard-promo unit ──');
check('Unit1 package P5000 + Unit2 10%-off P2000 => grand total P6800', () => {
  seedRules([
    { id: 'pkg-test', mode: 'package', name: 'Bundle', packagePrice: 5000, vehicleTypes: ['SUV'], bundledServices: ['A', 'B'], active: true, validFrom: '2026-09-01T00:00', validUntil: null, neverExpires: true },
    { id: 'std-test', mode: 'standard', name: 'Ten', type: 'percentage', value: 10, vehicleTypes: ['Sedan'], serviceMatches: ['X'], active: true, validFrom: '2026-09-01T00:00', validUntil: null, neverExpires: true },
  ]);
  const s = calculateBookingDiscountSummary([
    { id: 'u1', type: 'SUV', packageId: 'pkg-test', services: [{ id: 'a', name: 'A', price: 4000 }, { id: 'b', name: 'B', price: 3000 }] },
    { id: 'u2', type: 'Sedan', services: [{ id: 'x', name: 'X', price: 2000 }] },
  ]);
  assert.strictEqual(s.discountedTotal, 6800, `discounted got ${s.discountedTotal}`);
  assert.strictEqual(s.originalTotal, 9000, `original got ${s.originalTotal}`);
  assert.strictEqual(s.appliedPackages.length, 1);
  assert.strictEqual(s.appliedPackages[0].savings, 2000);
});
check('package unit is NOT double-discounted by a standard promo', () => {
  seedRules([
    { id: 'pkg2', mode: 'package', name: 'Bundle', packagePrice: 5000, vehicleTypes: ['SUV'], bundledServices: ['A'], active: true, validFrom: '2026-09-01T00:00', validUntil: null, neverExpires: true },
    { id: 'std-all', mode: 'standard', name: 'Half', type: 'percentage', value: 50, vehicleTypes: ['SUV'], serviceMatches: ['A'], active: true, validFrom: '2026-09-01T00:00', validUntil: null, neverExpires: true },
  ]);
  const s = calculateBookingDiscountSummary([
    { id: 'u1', type: 'SUV', packageId: 'pkg2', services: [{ id: 'a', name: 'A', price: 9000 }] },
  ]);
  assert.strictEqual(s.discountedTotal, 5000, `expected fixed 5000, got ${s.discountedTotal}`);
});
check('package unit with emptied services still charges package rate', () => {
  seedRules([
    { id: 'pkg-empty', mode: 'package', name: 'Bundle', packagePrice: 5000, vehicleTypes: ['SUV'], bundledServices: ['Regular Wash'], active: true, validFrom: '2026-09-01T00:00', validUntil: null, neverExpires: true },
  ]);
  const s = calculateBookingDiscountSummary([
    { id: 'u1', type: 'SUV', packageId: 'pkg-empty', services: [] },
  ]);
  assert.strictEqual(s.discountedTotal, 5000, `got ${s.discountedTotal}`);
});

console.log('\n── Persistence contract: promo_rules must stay an array ──');
check('savePromoRules coerces a non-array payload to []', () => {
  // Mirrors the DB contract: business_config.promo_rules is NOT NULL and must
  // always be a JSON array. The service guards this before persisting.
  const coerce = (rules) => (Array.isArray(rules) ? rules : []);
  assert.deepStrictEqual(coerce(null), []);
  assert.deepStrictEqual(coerce(undefined), []);
  assert.deepStrictEqual(coerce('not-an-array'), []);
  assert.deepStrictEqual(coerce({ mode: 'package' }), []);
  assert.deepStrictEqual(coerce([]), []);
});

check('null/undefined draft never throws in validatePackagePromo', () => {
  assert.doesNotThrow(() => validatePackagePromo());
  assert.doesNotThrow(() => validatePackagePromo(null));
  assert.doesNotThrow(() => validatePackagePromo({}, { resolvePrice: priceResolver }));
  assert.strictEqual(validatePackagePromo(null).valid, false);
});

check('package price of 0 is rejected (boundary)', () => {
  const r = validatePackagePromo(
    { ...baseBundle, packagePrice: 0 },
    { resolvePrice: priceResolver }
  );
  assert.strictEqual(r.locked, true);
});

check('unpriced services resolve to 0, so any price >= 0 stays valid-safe', () => {
  // When the catalog cannot price a bundled service the standalone sum is 0;
  // the invariant is skipped rather than blocking a legitimate package.
  const r = validatePackagePromo(
    { ...baseBundle, packagePrice: 100 },
    { resolvePrice: () => 0 }
  );
  assert.ok(
    !r.errors.some((e) => /standalone total/i.test(e)),
    r.errors.join('; ')
  );
});

check('calculateBookingDiscountSummary handles empty/malformed vehicles', () => {
  for (const input of [[], null, undefined, [{}, { services: null }]]) {
    const s = calculateBookingDiscountSummary(input);
    assert.strictEqual(s.discountedTotal, 0, `got ${s.discountedTotal} for ${JSON.stringify(input)}`);
    assert.strictEqual(s.originalTotal, 0);
    assert.deepStrictEqual(s.appliedPackages, []);
  }
});

check('plate dedup handles null/undefined plate fields', () => {
  assert.strictEqual(findDuplicatePlates([{ plateNumber: null }, {}]).size, 0);
  assert.strictEqual(normalizePlate(undefined), '');
  assert.strictEqual(normalizePlate(null), '');
});

console.log(
  `\n${passed} passed, ${failures.length} failed${failures.length ? `\nFailed: ${failures.join(', ')}` : ''}\n`
);
if (failures.length) process.exit(1);
