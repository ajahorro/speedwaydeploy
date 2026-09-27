/**
 * tests/service_catalog_visibility.test.js
 * ============================================================================
 * Verifies that Service Catalog CRUD actually reaches live bookings.
 *
 * THE DEFECT THIS COVERS
 * ----------------------
 * `getServiceCatalog()` returned SERVICES_DATA only, with the comment
 * "intentionally limited to the governed built-in services". The Business Hub
 * wrote admin edits to business_config.custom_services, ConfigContext mirrored
 * them into localStorage under 'speedway_custom_services', and BusinessHub.jsx
 * described that cache as "the local cache the pricing catalog reads from".
 *
 * It never read from it. So an admin could:
 *
 *   ADD    a service   -> persisted, never bookable
 *   EDIT   a price     -> persisted, old price still charged
 *   DELETE a service   -> persisted, still bookable
 *   ARCHIVE a service  -> persisted, still bookable
 *
 * The UI looked entirely healthy through all of it.
 *
 * Run: node tests/service_catalog_visibility.test.js
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

// servicesCatalog.js reads the GLOBAL `localStorage`. Stubbing only `window`
// leaves the global undefined, the merge sees no custom services, and every
// assertion below would pass while proving nothing.
const store = {};
const mockStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};
globalThis.window = { localStorage: mockStorage, addEventListener: () => { }, removeEventListener: () => { } };
globalThis.localStorage = mockStorage;

const setCustomServices = (list) => {
  store['speedway_custom_services'] = JSON.stringify(list);
};

const flatten = (catalog) => Object.values(catalog).flat();

(async () => {
  const { getServiceCatalog, SERVICES_DATA, getPackageStandaloneSum } =
    await import('../frontend/src/data/servicesCatalog.js');

  // ── Harness guard ─────────────────────────────────────────────────────────
  // Without this, a broken storage stub makes every test vacuous.
  check('harness: an empty cache returns the built-in catalog unchanged', () => {
    store['speedway_custom_services'] = '[]';
    const catalog = getServiceCatalog();
    assert.strictEqual(flatten(catalog).length, flatten(SERVICES_DATA).length);
  });

  // ── SCENARIO 1: ADD a service, it must become bookable ───────────────────
  console.log('\n=== SCENARIO 1: add a service -> bookable ===');

  setCustomServices([{
    id: 'custom_add_1',
    name: 'Hand Wax Premium',
    price: 850,
    description: 'Hand-applied premium wax.',
    generalService: 'Specialized Exterior Care',
    durationMinutes: 90,
    applicableVehicleTypes: ['Sedan'],
    vehicleType: 'Sedan',
    is_active: true,
    archived: false,
  }]);

  check('the new service appears in the booking catalog', () => {
    const found = flatten(getServiceCatalog()).find((s) => s.name === 'Hand Wax Premium');
    assert.ok(found, 'admin-added service is not visible to the booking flow');
  });

  check('it carries a price for the targeted vehicle', () => {
    const found = flatten(getServiceCatalog()).find((s) => s.name === 'Hand Wax Premium');
    assert.strictEqual(found.prices.Sedan, 850, 'a service with no usable price is bookable but free');
  });

  check('it is filed under the category the admin chose', () => {
    const catalog = getServiceCatalog();
    assert.ok(
      (catalog['Specialized Exterior Care'] || []).some((s) => s.name === 'Hand Wax Premium'),
      'the service should appear under its chosen category'
    );
  });

  // ── SCENARIO 2: ADD two services at once, both must land ─────────────────
  console.log('\n=== SCENARIO 2: add TWO services -> both bookable ===');

  setCustomServices([
    {
      id: 'custom_multi_a', name: 'Tire Shine', price: 200,
      generalService: 'Specialized Exterior Care', durationMinutes: 30,
      applicableVehicleTypes: ['Sedan'], is_active: true, archived: false,
    },
    {
      id: 'custom_multi_b', name: 'Cabin Fog', price: 400,
      generalService: 'Interior & Cabin Care', durationMinutes: 45,
      applicableVehicleTypes: ['Sedan'], is_active: true, archived: false,
    },
  ]);

  check('both added services are visible', () => {
    const names = flatten(getServiceCatalog()).map((s) => s.name);
    assert.ok(names.includes('Tire Shine'), 'first added service missing');
    assert.ok(names.includes('Cabin Fog'), 'second added service missing');
  });

  check('each keeps its own price and category', () => {
    const catalog = getServiceCatalog();
    assert.strictEqual(catalog['Specialized Exterior Care'].find((s) => s.name === 'Tire Shine').prices.Sedan, 200);
    assert.strictEqual(catalog['Interior & Cabin Care'].find((s) => s.name === 'Cabin Fog').prices.Sedan, 400);
  });

  // ── SCENARIO 3: EDIT a built-in price -> the new price is charged ────────
  console.log('\n=== SCENARIO 3: edit a built-in price -> new price applies ===');

  const builtInWash = flatten(SERVICES_DATA).find((s) => s.name === 'Regular Wash');
  const originalSedan = builtInWash.prices.Sedan;

  setCustomServices([{
    id: 'custom_edit_wash',
    name: 'Regular Wash',
    price: 175,
    generalService: 'Premium Car Wash',
    durationMinutes: 60,
    applicableVehicleTypes: ['Sedan'],
    vehicleType: 'Sedan',
    is_active: true,
    archived: false,
  }]);

  check(`the Sedan price changes from ${originalSedan} to 175`, () => {
    const wash = flatten(getServiceCatalog()).find((s) => s.name === 'Regular Wash');
    assert.strictEqual(wash.prices.Sedan, 175, 'the admin price edit did not reach the booking catalog');
  });

  check('the SUV price is UNTOUCHED (edits are per vehicle category)', () => {
    const wash = flatten(getServiceCatalog()).find((s) => s.name === 'Regular Wash');
    assert.strictEqual(
      wash.prices.SUV,
      builtInWash.prices.SUV,
      'editing the Sedan price must not overwrite the SUV price'
    );
  });

  check('editing does not DUPLICATE the service', () => {
    const matches = flatten(getServiceCatalog()).filter((s) => s.name === 'Regular Wash');
    assert.strictEqual(matches.length, 1, `expected 1 Regular Wash, found ${matches.length}`);
  });

  check('the edited price flows into the package standalone sum', () => {
    // Proves the override reaches the pricing consumers, not just the listing.
    const sum = getPackageStandaloneSum(
      { mode: 'package', vehicleServiceMatrix: { Sedan: ['Regular Wash'] } },
      'Sedan'
    );
    assert.strictEqual(sum, 175, 'the promo price lookup still reads the built-in price');
  });

  // ── SCENARIO 4: ARCHIVE a service -> no longer bookable ──────────────────
  console.log('\n=== SCENARIO 4: archive a service -> not bookable ===');

  setCustomServices([{
    id: 'custom_archived_wash',
    name: 'Regular Wash',
    price: originalSedan,
    generalService: 'Premium Car Wash',
    applicableVehicleTypes: ['Sedan', 'SUV', 'Van/L300'],
    is_active: false,
    archived: true,
  }]);

  check('an archived built-in is removed from the catalog', () => {
    const wash = flatten(getServiceCatalog()).find((s) => s.name === 'Regular Wash');
    assert.ok(!wash, 'an archived service is still bookable — the admin asked for it to disappear');
  });

  check('the built-in constant itself is NOT mutated', () => {
    // The merge must return a new object; mutating SERVICES_DATA would make the
    // change permanent for the rest of the session and break a later un-archive.
    assert.ok(
      flatten(SERVICES_DATA).find((s) => s.name === 'Regular Wash'),
      'SERVICES_DATA was mutated by the merge — un-archiving could never restore it'
    );
  });

  // ── SCENARIO 5: DELETE a custom service -> it disappears ─────────────────
  console.log('\n=== SCENARIO 5: delete a custom service -> gone ===');

  setCustomServices([
    { id: 'custom_keep', name: 'Keep Me', price: 100, generalService: 'Premium Car Wash', applicableVehicleTypes: ['Sedan'], is_active: true, archived: false },
    { id: 'custom_drop', name: 'Drop Me', price: 200, generalService: 'Premium Car Wash', applicableVehicleTypes: ['Sedan'], is_active: true, archived: false },
  ]);

  check('both are present before the delete', () => {
    const names = flatten(getServiceCatalog()).map((s) => s.name);
    assert.ok(names.includes('Keep Me') && names.includes('Drop Me'));
  });

  setCustomServices([
    { id: 'custom_keep', name: 'Keep Me', price: 100, generalService: 'Premium Car Wash', applicableVehicleTypes: ['Sedan'], is_active: true, archived: false },
  ]);

  check('the deleted service is gone and the other survives', () => {
    const names = flatten(getServiceCatalog()).map((s) => s.name);
    assert.ok(!names.includes('Drop Me'), 'a deleted service is still bookable');
    assert.ok(names.includes('Keep Me'), 'deleting one service removed an unrelated one');
  });

  // ── SCENARIO 6: multiple vehicle categories ─────────────────────────────
  console.log('\n=== SCENARIO 6: a service targeting several vehicle categories ===');

  setCustomServices([{
    id: 'custom_multivehicle',
    name: 'Multi Vehicle Service',
    price: 300,
    generalService: 'Premium Car Wash',
    applicableVehicleTypes: ['Sedan', 'SUV', 'Regular'],
    is_active: true,
    archived: false,
  }]);

  check('it is priced for every targeted category', () => {
    const found = flatten(getServiceCatalog()).find((s) => s.name === 'Multi Vehicle Service');
    assert.strictEqual(found.prices.Sedan, 300);
    assert.strictEqual(found.prices.SUV, 300);
    assert.strictEqual(found.prices.Regular, 300, 'motorcycle alias should normalise to Regular');
  });

  check('a category it does not target is absent (not silently 0)', () => {
    const found = flatten(getServiceCatalog()).find((s) => s.name === 'Multi Vehicle Service');
    assert.strictEqual(found.prices['Van/L300'], undefined, 'an untargeted category must be absent, not priced 0');
  });

  // ── Resilience ───────────────────────────────────────────────────────────
  console.log('\n=== resilience ===');

  check('a corrupt cache falls back to the built-in catalog', () => {
    store['speedway_custom_services'] = '{not valid json';
    const catalog = getServiceCatalog();
    assert.strictEqual(flatten(catalog).length, flatten(SERVICES_DATA).length, 'a corrupt cache must not empty the catalog');
  });

  check('a non-array cache is ignored', () => {
    store['speedway_custom_services'] = '{"nope":true}';
    assert.strictEqual(flatten(getServiceCatalog()).length, flatten(SERVICES_DATA).length);
  });

  check('a custom entry with no name is skipped, not crashing', () => {
    setCustomServices([{ id: 'no_name', price: 100 }]);
    assert.strictEqual(flatten(getServiceCatalog()).length, flatten(SERVICES_DATA).length);
  });

  check('a custom entry with a non-numeric price becomes 0, not NaN', () => {
    setCustomServices([{ id: 'bad_price', name: 'Bad Price', price: 'free', generalService: 'Premium Car Wash', applicableVehicleTypes: ['Sedan'], is_active: true }]);
    const found = flatten(getServiceCatalog()).find((s) => s.name === 'Bad Price');
    assert.ok(Number.isFinite(found.prices.Sedan), 'price must be a finite number');
    assert.strictEqual(found.prices.Sedan, 0);
  });

  check('an empty custom list returns the built-in catalog by reference (no needless copy)', () => {
    setCustomServices([]);
    assert.strictEqual(getServiceCatalog(), SERVICES_DATA);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();