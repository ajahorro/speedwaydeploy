/**
 * tests/vat_split.test.js
 * ============================================================================
 * FLAT, TAX-FREE PRICING — the replacement for the old VAT-split suite.
 *
 * WHY THIS FILE CHANGED
 * ---------------------
 * This suite used to derive a 12% VAT split from an inclusive total
 * (`base = gross / 1.12`) and assert the shared amount model agreed. VAT has now
 * been removed from the system entirely, so the assertions are INVERTED: instead
 * of pinning the split, this file pins its ABSENCE.
 *
 * That inversion matters. A tax figure computed in more than one place eventually
 * disagrees with itself — which is exactly what happened here, twice: the
 * on-screen receipt once ADDED 12% on top (turning a ₱2,500 booking into a ₱2,800
 * "Total Amount Due") while the emailed receipt EXTRACTED it, so the same booking
 * printed two different totals. Removing the concept removes that whole class of
 * defect, and this file is what stops it creeping back in.
 *
 * WHAT IS ASSERTED
 *   • the total due IS the price — no division, no inflation
 *   • no `vatIncluded` / `vatExclusiveSales` keys are produced at all
 *   • the frontend and backend resolvers agree on the flat figure
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

console.log('=== flat, tax-free pricing ===');

for (const price of [250, 1000, 500, 1234.56, 99.99, 2500]) {
  check(`P${price}: the amount due IS the price (no tax added or extracted)`, () => {
    const a = resolveTransactionAmounts({ total_amount: price }, null);
    assert.strictEqual(a.totalDue, price, 'the total due must equal the price exactly');
    assert.strictEqual(a.bookingTotal, price);
  });

  check(`P${price}: no VAT keys are produced`, () => {
    const a = resolveTransactionAmounts({ total_amount: price }, null);
    // Absence, not zero. A silently-zero tax line is far easier to overlook than
    // a missing one — and `undefined` fails loudly at the point of use.
    assert.ok(!('vatIncluded' in a), 'vatIncluded must be absent, not merely undefined');
    assert.ok(!('vatExclusiveSales' in a), 'vatExclusiveSales must be absent, not merely undefined');
  });

  check(`P${price}: centavos survive untouched`, () => {
    const a = resolveTransactionAmounts({ total_amount: price }, null);
    assert.strictEqual(round2(a.totalDue), round2(price));
  });
}

console.log('\n=== the old VAT behaviour must not return ===');

check('P250 is NOT divided by 1.12 (no 223.21 base)', () => {
  const a = resolveTransactionAmounts({ total_amount: 250 }, null);
  assert.notStrictEqual(a.totalDue, round2(250 / 1.12), 'the price must not be deflated by a tax divisor');
  assert.strictEqual(a.totalDue, 250);
});

check('P250 is NOT inflated by 12% (no 280 total)', () => {
  const a = resolveTransactionAmounts({ total_amount: 250 }, null);
  assert.notStrictEqual(a.totalDue, 280, 'tax must never be added on top');
  assert.strictEqual(a.totalDue, 250);
});

check('P2,500 is not inflated to P2,800 on a receipt total', () => {
  // The specific production defect: a P2,500 booking printed a P2,800 total that
  // was never charged and existed nowhere in the database.
  const a = resolveTransactionAmounts({ total_amount: 2500 }, null);
  assert.strictEqual(a.totalDue, 2500);
  assert.notStrictEqual(a.totalDue, 2800);
});

console.log('\n=== edge cases ===');

check('a zero total stays zero rather than NaN', () => {
  const a = resolveTransactionAmounts({ total_amount: 0 }, null);
  assert.strictEqual(a.totalDue, 0);
  assert.ok(Number.isFinite(a.totalDue));
});

check('a missing total is treated as zero, not NaN', () => {
  const a = resolveTransactionAmounts({}, null);
  assert.strictEqual(a.totalDue, 0);
  assert.ok(Number.isFinite(a.totalDue));
});

check('a payment does not change the booking total', () => {
  // Flat pricing still has to be READ-ONLY with respect to the booking.
  for (const paid of [0, 500, 2500, 9999]) {
    const a = resolveTransactionAmounts({ total_amount: 2500 }, { amount: paid, status: 'PAID' });
    assert.strictEqual(a.bookingTotal, 2500, `a P${paid} payment must not alter the total`);
  }
});

check('the balance is pure subtraction, with no tax adjustment', () => {
  const a = resolveTransactionAmounts({ total_amount: 2500 }, { amount: 1000, status: 'PAID' });
  assert.strictEqual(a.creditedToBooking, 1000);
  assert.strictEqual(a.remainingBalance, 1500, '2500 - 1000, with no tax term');
});

console.log('\n=== the frontend twin agrees (no tax divergence) ===');

(async () => {
  const frontend = await import('../frontend/src/utils/paymentAmounts.js');

  check('the frontend resolver also produces no VAT keys', () => {
    const a = frontend.resolveTransactionAmounts({ total_amount: 2500 }, null);
    assert.ok(!('vatIncluded' in a));
    assert.ok(!('vatExclusiveSales' in a));
  });

  check('frontend and backend agree on the flat total for every sample', () => {
    for (const price of [250, 1000, 1234.56, 2500, 99.99]) {
      const fe = frontend.resolveTransactionAmounts({ total_amount: price }, null);
      const be = resolveTransactionAmounts({ total_amount: price }, null);
      assert.strictEqual(fe.totalDue, be.totalDue, `P${price} diverged`);
      assert.strictEqual(fe.totalDue, price);
    }
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();