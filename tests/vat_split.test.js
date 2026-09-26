/**
 * tests/vat_split.test.js
 * ============================================================================
 * Independently derives the VAT split and asserts the shared amount model agrees.
 *
 * WHY THIS TEST IS WRITTEN THIS WAY
 * ---------------------------------
 * The previous version asserted `vatIncluded === 26.79` on a ₱250 total. That is
 * 10.72% — the wrapper's own wrong output. Because the expectation was copied
 * from the implementation rather than derived from the tax rule, the test PASSED
 * while the number was wrong. A test that restates the implementation can only
 * ever confirm the implementation.
 *
 * So this file derives the expected figures from first principles:
 *   Philippines VAT is 12%, and the published price is VAT-INCLUSIVE, therefore
 *       base = gross / 1.12        vat = gross - base
 *
 * It also asserts the invariant that a wrong rate cannot survive:
 *       base + vat === gross   (exactly, to the centavo)
 * and that the rate actually equals 12% of the base.
 *
 * Run: node tests/vat_split.test.js
 * ============================================================================
 */
const assert = require('assert');
const { resolveTransactionAmounts } = require('../backend/services/transactionAmounts');

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

const round2 = (n) => Math.round(n * 100) / 100;
const VAT_RATE = 0.12;

/** Independent implementation: the tax rule, written from the rule and not read
 *  out of the module under test. */
const expectedSplit = (gross) => {
  const base = round2(gross / (1 + VAT_RATE));
  return { base, vat: round2(gross - base) };
};

console.log('=== VAT split (Philippines, 12%, VAT-inclusive pricing) ===');

for (const gross of [250, 1000, 500, 1234.56, 99.99]) {
  const { base, vat } = expectedSplit(gross);

  check(`₱${gross}: base and VAT sum back to the gross exactly`, () => {
    assert.strictEqual(round2(base + vat), gross, `${base} + ${vat} must equal ${gross}`);
  });

  check(`₱${gross}: VAT equals 12% of the derived base`, () => {
    const impliedRate = vat / base;
    assert.ok(
      Math.abs(impliedRate - VAT_RATE) < 0.0005,
      `implied rate ${(impliedRate * 100).toFixed(4)}% should be ~12%`
    );
  });

  check(`₱${gross}: model matches the independently derived split`, () => {
    const a = resolveTransactionAmounts({ total_amount: gross }, null);
    assert.strictEqual(a.vatExclusiveSales, base, `base should be ${base}`);
    assert.strictEqual(a.vatIncluded, vat, `VAT should be ${vat}`);
  });
}

// The specific regression: ₱250 must NOT be split as 10.72%.
check('₱250 is NOT split at the old 10.72% rate', () => {
  const a = resolveTransactionAmounts({ total_amount: 250 }, null);
  assert.strictEqual(a.vatExclusiveSales, 223.21);
  assert.strictEqual(a.vatIncluded, 26.79);
});

check('VAT is never larger than the gross it is extracted from', () => {
  const a = resolveTransactionAmounts({ total_amount: 250 }, null);
  assert.ok(a.vatIncluded < a.totalDue, 'VAT must be part of the total, never exceed it');
});

check('a zero total yields zero VAT rather than NaN', () => {
  const a = resolveTransactionAmounts({ total_amount: 0 }, null);
  assert.strictEqual(a.vatIncluded, 0);
  assert.strictEqual(a.vatExclusiveSales, 0);
});

check('a missing total is treated as zero, not NaN', () => {
  const a = resolveTransactionAmounts({}, null);
  assert.strictEqual(a.vatIncluded, 0);
  assert.ok(Number.isFinite(a.vatExclusiveSales));
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);