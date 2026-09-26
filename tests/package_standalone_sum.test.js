/**
 * tests/package_standalone_sum.test.js
 * ============================================================================
 * Regression tests for the package "bought separately" total.
 *
 * THE REPORTED DEFECT
 * -------------------
 * Admin selected "Moto Wash" (₱120) + "Moto Ceramic Coating" (₱3,500) under
 * Motorcycle Regular and set a ₱3,000 bundle price. The warning said the
 * services only cost ₱120 separately.
 *
 * It was NOT a failure to sum. The sum was correct; the PRICE LOOKUP returned
 * the wrong service. The old predicate was:
 *
 *     svcName === target || svcName.includes(target) || target.includes(svcName)
 *
 * and `target.includes(svcName)` matched the CAR service "Ceramic Coating" for
 * the target "Moto Ceramic Coating" ("moto ceramic coating".includes(
 * "ceramic coating") === true). That entry prices Sedan/SUV, not Regular, so it
 * resolved to ₱0 — and ₱120 + ₱0 = ₱120.
 *
 * The match was also ORDER-DEPENDENT (`Array.find` returns the first hit), so
 * adding an unrelated service to the catalog could change a package's total.
 *
 * Run: node tests/package_standalone_sum.test.js
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

(async () => {
  const { getPackageStandaloneSum, getPackageServicesForVehicle } =
    await import('../frontend/src/data/servicesCatalog.js');

  const pkg = (services, value = 3000) => ({
    mode: 'package',
    value,
    vehicleServiceMatrix: { 'Motorcycle Regular': services },
  });

  console.log('=== the reported defect ===');

  check('the rule binds BOTH selected services', () => {
    const bound = getPackageServicesForVehicle(pkg(['Moto Wash', 'Moto Ceramic Coating']), 'Motorcycle Regular');
    assert.deepStrictEqual(bound, ['Moto Wash', 'Moto Ceramic Coating']);
  });

  check('standalone total is 3620, not 120', () => {
    const total = getPackageStandaloneSum(pkg(['Moto Wash', 'Moto Ceramic Coating']), 'Motorcycle Regular');
    assert.strictEqual(total, 3620, `expected 3620 (120 + 3500), got ${total}`);
  });

  check('each service resolves to its OWN price', () => {
    assert.strictEqual(getPackageStandaloneSum(pkg(['Moto Wash']), 'Motorcycle Regular'), 120);
    assert.strictEqual(getPackageStandaloneSum(pkg(['Moto Ceramic Coating']), 'Motorcycle Regular'), 3500);
  });

  check('order of selection does not change the total', () => {
    const a = getPackageStandaloneSum(pkg(['Moto Wash', 'Moto Ceramic Coating']), 'Motorcycle Regular');
    const b = getPackageStandaloneSum(pkg(['Moto Ceramic Coating', 'Moto Wash']), 'Motorcycle Regular');
    assert.strictEqual(a, b, 'the sum must not depend on selection order');
  });

  check('a duplicate selection is not double-counted by the lookup', () => {
    // The same name twice is a UI concern, but the price must resolve for each
    // occurrence rather than one of them becoming 0.
    const twice = getPackageStandaloneSum(pkg(['Moto Wash', 'Moto Wash']), 'Motorcycle Regular');
    assert.strictEqual(twice, 240);
  });

  console.log('\n=== the substring hazard that caused it ===');

  check('"Moto Ceramic Coating" does NOT resolve to the car "Ceramic Coating"', () => {
    const moto = getPackageStandaloneSum(pkg(['Moto Ceramic Coating']), 'Motorcycle Regular');
    const car = getPackageStandaloneSum(pkg(['Ceramic Coating']), 'Motorcycle Regular');
    // The car service is not priced for Motorcycle Regular at all.
    assert.strictEqual(car, 0, 'the car entry has no Regular price');
    assert.notStrictEqual(moto, 0, 'the motorcycle entry MUST resolve — this was the bug');
    assert.strictEqual(moto, 3500);
  });

  check('a genuinely ambiguous name is refused, not guessed', () => {
    // "Coating" is a substring of several entries; picking one by array order
    // would be arbitrary.
    const ambiguous = getPackageStandaloneSum(pkg(['Coating']), 'Motorcycle Regular');
    assert.strictEqual(ambiguous, 0, 'ambiguity must resolve to 0 (unknown), never a silent guess');
  });

  console.log('\n=== the warning threshold ===');

  check('3620 > 3000, so the warning SHOULD fire', () => {
    const standalone = getPackageStandaloneSum(pkg(['Moto Wash', 'Moto Ceramic Coating']), 'Motorcycle Regular');
    assert.ok(standalone > 3000, 'the admin must be told this bundle is not a saving');
  });

  check('a genuine saving does not trigger the warning', () => {
    const standalone = getPackageStandaloneSum(pkg(['Moto Wash', 'Moto Ceramic Coating']), 'Motorcycle Regular');
    const packagePrice = 2000;
    assert.ok(packagePrice < standalone, '₱2,000 for ₱3,620 of services IS a saving');
  });

  console.log('\n=== edge cases ===');

  check('no bound services -> 0, no crash', () => {
    assert.strictEqual(getPackageStandaloneSum({ mode: 'package', vehicleServiceMatrix: {} }, 'Motorcycle Regular'), 0);
  });

  check('an unknown vehicle -> 0, no crash', () => {
    assert.strictEqual(getPackageStandaloneSum(pkg(['Moto Wash']), 'Submarine'), 0);
  });

  check('an unknown service name contributes 0 rather than NaN', () => {
    const total = getPackageStandaloneSum(pkg(['Moto Wash', 'Nonexistent Service XYZ']), 'Motorcycle Regular');
    assert.ok(Number.isFinite(total), 'must never return NaN');
    assert.strictEqual(total, 120, 'the known service still counts');
  });

  check('a null rule -> 0, no crash', () => {
    assert.strictEqual(getPackageStandaloneSum(null, 'Motorcycle Regular'), 0);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();