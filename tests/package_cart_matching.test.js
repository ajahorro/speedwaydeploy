/**
 * tests/package_cart_matching.test.js
 * ============================================================================
 * Regression tests for package→cart matching (getActivePackageForVehicle).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `packageSetIsComplete` decided whether a customer is charged a BUNDLE price.
 * Its predicate was:
 *
 *     sel === req || sel.includes(req) || req.includes(sel)
 *
 * Both `includes` arms caused real mispricing. Measured against the live catalog,
 * with a bundle requiring ['Moto Wash', 'Moto Ceramic Coating']:
 *
 *   HAZARD 1  `req.includes(sel)` made the bundle APPLY to a cart that did not
 *             contain it: ['Moto Wash', 'Ceramic Coating'] was charged ₱3,000,
 *             even though 'Ceramic Coating' is the CAR service.
 *
 *   HAZARD 2  `sel.includes(req)` let a generic 'Wash' satisfy 'Moto Wash'.
 *
 * A false positive here is a BILLING error, not a display glitch — hence exact
 * matching only.
 *
 * WHY THE PREFIX IS NOT STRIPPED
 * ------------------------------
 * An earlier attempt normalised away a leading 'moto ' so that 'Ceramic Coating'
 * and 'Moto Ceramic Coating' compared equal. The catalog lists them as separate
 * services at very different prices:
 *
 *     Ceramic Coating       Sedan ₱10,000   SUV ₱13,000
 *     Moto Ceramic Coating  Regular ₱3,500  Bigbike ₱5,500
 *
 * Collapsing them would let a ₱10,000 car service satisfy a ₱3,500 motorcycle
 * requirement — a ₱7,000 under-charge, strictly worse than the original defect.
 *
 * Run: node tests/package_cart_matching.test.js
 * ============================================================================
 */
const assert = require('assert');

let passed = 0;
let failed = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL  ${label}\n      ${err.message}`);
    failed += 1;
  }
};

// servicesCatalog.js reads the GLOBAL `localStorage`, not `window.localStorage`.
// Stubbing only `window` leaves the global undefined, getPromoRules() returns [],
// and every assertion below would pass vacuously. Both are set for that reason.
const store = {};
const mockStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};
globalThis.window = { localStorage: mockStorage, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.localStorage = mockStorage;

const MOTO_BUNDLE = {
  id: 'test-moto-bundle',
  name: 'Moto Ceramic Bundle',
  mode: 'package',
  type: 'fixed_package',
  value: 3000,
  validFrom: '2020-01-01T00:00',
  neverExpires: true,
  isBundle: true,
  stackable: false,
  vehicleServiceMatrix: {
    'Motorcycle Regular': ['Moto Wash', 'Moto Ceramic Coating'],
  },
};

const SEDAN_BUNDLE = {
  id: 'test-sedan-bundle',
  name: 'Sedan Trio',
  mode: 'package',
  type: 'fixed_package',
  value: 1200,
  validFrom: '2020-01-01T00:00',
  neverExpires: true,
  isBundle: true,
  stackable: false,
  vehicleServiceMatrix: {
    Sedan: ['Regular Wash', 'Engine Wash', 'Mags Detailing'],
  },
};

store['speedway_promo_rules'] = JSON.stringify([MOTO_BUNDLE, SEDAN_BUNDLE]);

(async () => {
  const { getActivePackageForVehicle, getPromoRules } =
    await import('../frontend/src/data/servicesCatalog.js');

  // ── Harness guard ─────────────────────────────────────────────────────────
  // Without this, a storage-stub mistake makes every test below pass while
  // proving nothing. Fail loudly instead.
  check('harness: promo rules are visible to the module', () => {
    assert.ok(getPromoRules().length > 0, 'getPromoRules() returned [] — the localStorage stub is not working, so all other assertions would be vacuous');
  });

  const applies = (vehicle, cart) => Boolean(getActivePackageForVehicle(vehicle, cart));

  console.log('\n=== the bundle must apply when the cart is genuinely complete ===');

  check('exact full bundle applies', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Moto Wash', 'Moto Ceramic Coating']), true);
  });

  check('selection order does not matter', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Moto Ceramic Coating', 'Moto Wash']), true);
  });

  check('a superset cart still applies the bundle', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Moto Wash', 'Moto Ceramic Coating', 'Moto Engine Wash']), true);
  });

  check('case and whitespace differences still match', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['  moto wash ', 'MOTO CERAMIC COATING']), true);
  });

  console.log('\n=== HAZARD 1: a different vehicle class must NOT satisfy it ===');

  check('car "Ceramic Coating" does NOT satisfy "Moto Ceramic Coating"', () => {
    assert.strictEqual(
      applies('Motorcycle Regular', ['Moto Wash', 'Ceramic Coating']),
      false,
      'the CAR ceramic coating (₱10,000) must never unlock the motorcycle bundle (₱3,000)'
    );
  });

  check('the car service alone does not apply the motorcycle bundle', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Ceramic Coating']), false);
  });

  check('moto services do NOT satisfy the sedan bundle either', () => {
    assert.strictEqual(applies('Sedan', ['Regular Wash', 'Engine Wash', 'Mags Detailing']), true, 'control: the sedan bundle works');
    assert.strictEqual(
      applies('Sedan', ['Moto Wash', 'Moto Ceramic Coating']),
      false,
      'a motorcycle service must not complete a sedan bundle'
    );
  });

  console.log('\n=== HAZARD 2: a generic substring must NOT satisfy a specific name ===');

  check('generic "Wash" does NOT satisfy "Moto Wash"', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Wash', 'Moto Ceramic Coating']), false);
  });

  check('"Coating" does NOT satisfy "Moto Ceramic Coating"', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Moto Wash', 'Coating']), false);
  });

  check('a partial service name does not unlock a bundle', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Moto', 'Ceramic']), false);
  });

  console.log('\n=== HAZARD 3: an incomplete cart must NOT apply ===');

  check('one of two required services is not enough', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Moto Wash']), false);
  });

  check('the second service alone is not enough', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Moto Ceramic Coating']), false);
  });

  check('an empty cart does not apply a bundle', () => {
    assert.strictEqual(applies('Motorcycle Regular', []), false);
  });

  check('an unrelated cart does not apply a bundle', () => {
    assert.strictEqual(applies('Motorcycle Regular', ['Full Detail', 'Engine Wash']), false);
  });

  console.log('\n=== returned shape ===');

  check('the resolved package reports the correct price and services', () => {
    const active = getActivePackageForVehicle('Motorcycle Regular', ['Moto Wash', 'Moto Ceramic Coating']);
    assert.ok(active, 'bundle should resolve');
    assert.strictEqual(active.packagePrice, 3000);
    assert.deepStrictEqual(active.requiredServices, ['Moto Wash', 'Moto Ceramic Coating']);
    assert.strictEqual(active.rule.id, 'test-moto-bundle', 'the MOTORCYCLE bundle must be the one resolved');
  });

  check('a null / missing vehicle type resolves to no package', () => {
    assert.strictEqual(getActivePackageForVehicle(null, ['Moto Wash', 'Moto Ceramic Coating']), null);
    assert.strictEqual(getActivePackageForVehicle('', ['Moto Wash']), null);
  });

  check('a non-array cart does not throw', () => {
    assert.strictEqual(getActivePackageForVehicle('Motorcycle Regular', null), null);
    assert.strictEqual(getActivePackageForVehicle('Motorcycle Regular', 'Moto Wash'), null);
  });

  console.log('\n=== the ambiguity that made a substring arm unsafe ===');

  check('short names are genuinely ambiguous across the catalog', async () => {
    // Documents WHY exact matching is required rather than a uniqueness check:
    // 'Wash' alone loosely matches four catalog entries, so "exactly one match
    // in this cart" would still be a guess about intent.
    const { getServiceCatalog } = await import('../frontend/src/data/servicesCatalog.js');
    const all = Object.values(getServiceCatalog()).flat();
    const norm = (s) => String(s || '').trim().toLowerCase();
    const loose = all.filter((s) => {
      const n = norm(s.name);
      return n.includes('wash') || 'wash'.includes(n);
    });
    assert.ok(loose.length > 1, `expected "Wash" to be ambiguous, got ${loose.length} match(es)`);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();