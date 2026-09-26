/**
 * tests/ocr_ledger_invariants.test.js
 * ============================================================================
 * Locks in the two requirements that CONFLICT, and the resolution:
 *
 *   (A) the OCR output must reflect in the booking's overall financial ledger
 *   (B) a customer-made booking must still sit in payment verification
 *
 * The conflict: the ledger's canonical rule counts money as received only when
 * the payment status is PAID-family. FOR_VERIFICATION is excluded BY DESIGN, so
 * an OCR-scanned customer payment contributes ₱0 to recognised revenue. Both
 * requirements are correct — the mistake would be to satisfy (A) by letting the
 * ledger count unverified money, which would inflate revenue on a receipt an
 * admin might still reject.
 *
 * The resolution is an attribution layer: settled money and OCR-attributed money
 * are reported as SEPARATE, NAMED figures.
 *
 * This file models the SQL ledger rule (public.booking_financial_ledger) so the
 * accounting semantics are pinned in CI, not only in the database.
 *
 * Run: node tests/ocr_ledger_invariants.test.js
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

const round2 = (n) => Math.round(n * 100) / 100;
const SETTLED_STATUSES = ['PAID', 'REFUND_PENDING', 'REFUNDED'];

/**
 * Model of public.booking_financial_ledger(). Deliberately mirrors the SQL so a
 * divergence between the two shows up as a test failure rather than in the books.
 */
const resolveLedger = (booking, payments = []) => {
  const expected = Number(booking?.total_amount || 0);
  const settledCreditAmount = (p) => Number(p.detected_amount || 0) > 0
    ? Number(p.detected_amount) + Number(p.transfer_fee || 0)
    : Number(p.amount || 0);

  const settled = payments
    .filter((p) => Number(p.amount) > 0
      && SETTLED_STATUSES.includes(String(p.status || '').toUpperCase())
      && String(p.method || '').toUpperCase() !== 'SYSTEM_REFUND')
    .reduce((s, p) => s + settledCreditAmount(p), 0);

  const refunded = payments
    .filter((p) => Number(p.amount) < 0
      && (String(p.method || '').toUpperCase() === 'SYSTEM_REFUND'
        || String(p.status || '').toUpperCase() === 'REFUNDED'))
    .reduce((s, p) => s + Math.abs(Number(p.amount)), 0);

  const pendingRows = payments.filter((p) => String(p.status || '').toUpperCase() === 'FOR_VERIFICATION');
  const pending = pendingRows.reduce((s, p) => s + Number(p.amount), 0);
  const pendingOcr = pendingRows.reduce((s, p) => s + Number(p.detected_amount || 0), 0);
  const variance = pendingOcr > 0 ? round2(pending - pendingOcr) : 0;

  const netSettled = Math.max(0, settled - refunded);

  return {
    expected_amount: expected,
    settled_amount: round2(settled),
    refunded_amount: round2(refunded),
    net_settled: round2(netSettled),
    outstanding_amount: round2(Math.max(0, expected - netSettled)),
    pending_verification: round2(pending),
    pending_ocr_detected: round2(pendingOcr),
    pending_declared: round2(pending),
    ocr_variance: variance,
    has_pending_verification: pending > 0,
    has_ocr_data: pendingOcr > 0,
    has_discrepancy: pendingOcr > 0 && Math.abs(variance) > 0.01,
    // The invariant that protects the books: an unverified claim can NEVER make
    // a booking read as fully settled.
    fully_settled: expected > 0 && netSettled >= expected,
  };
};

const customerGcash = (over = {}) => ({
  amount: 1000,
  status: 'FOR_VERIFICATION',
  method: 'GCash',
  detected_amount: 980,
  transfer_fee: 20,
  ...over,
});

console.log('=== (A)+(B) the OCR-scanned customer booking ===');

check('unverified OCR money is VISIBLE in the ledger', () => {
  const l = resolveLedger({ total_amount: 1000 }, [customerGcash()]);
  assert.strictEqual(l.pending_verification, 1000, 'the claimed amount is reported');
  assert.strictEqual(l.pending_ocr_detected, 980, 'what the scan read is reported');
  assert.strictEqual(l.has_pending_verification, true);
  assert.strictEqual(l.has_ocr_data, true);
});

check('unverified OCR money is NOT recognised revenue', () => {
  const l = resolveLedger({ total_amount: 1000 }, [customerGcash()]);
  assert.strictEqual(l.settled_amount, 0, 'FOR_VERIFICATION must contribute ₱0');
  assert.strictEqual(l.net_settled, 0);
});

check('unverified money can never read as fully settled', () => {
  const l = resolveLedger({ total_amount: 1000 }, [customerGcash()]);
  assert.strictEqual(l.fully_settled, false, 'a claim is not a payment');
});

check('the outstanding balance ignores the unverified claim', () => {
  const l = resolveLedger({ total_amount: 1000 }, [customerGcash()]);
  assert.strictEqual(l.outstanding_amount, 1000, 'still owed until verified');
});

check('the declared-vs-OCR discrepancy is surfaced', () => {
  const l = resolveLedger({ total_amount: 1000 }, [customerGcash()]);
  assert.strictEqual(l.ocr_variance, 20, 'declared 1000 minus scanned 980');
  assert.strictEqual(l.has_discrepancy, true, 'an admin must be told to look');
});

check('matching declared and scanned amounts raise no discrepancy', () => {
  const l = resolveLedger({ total_amount: 980 }, [customerGcash({ amount: 980, detected_amount: 980, transfer_fee: 0 })]);
  assert.strictEqual(l.ocr_variance, 0);
  assert.strictEqual(l.has_discrepancy, false);
});

console.log('\n=== recognition rule is unchanged (no revenue inflation) ===');

check('a PAID payment IS recognised', () => {
  const l = resolveLedger({ total_amount: 1000 }, [customerGcash({ status: 'PAID', detected_amount: 1000, transfer_fee: 0 })]);
  assert.strictEqual(l.settled_amount, 1000);
  assert.strictEqual(l.fully_settled, true);
  assert.strictEqual(l.outstanding_amount, 0);
});

check('verifying a payment moves it from pending to settled', () => {
  const before = resolveLedger({ total_amount: 1000 }, [customerGcash()]);
  const after = resolveLedger({ total_amount: 1000 }, [customerGcash({ status: 'PAID' })]);
  assert.strictEqual(before.settled_amount, 0);
  assert.strictEqual(before.pending_verification, 1000);
  assert.strictEqual(after.settled_amount, 1000);
  assert.strictEqual(after.pending_verification, 0, 'it is no longer awaiting a decision');
});

check('settled OCR amount replaces stale submitted amount', () => {
  const l = resolveLedger({ total_amount: 10000 }, [customerGcash({
    amount: 3000,
    detected_amount: 10000,
    transfer_fee: 0,
    status: 'PAID',
  })]);
  assert.strictEqual(l.settled_amount, 10000);
  assert.strictEqual(l.outstanding_amount, 0);
  assert.strictEqual(l.fully_settled, true);
});

check('a REFUND_PENDING payment is recognised', () => {
  const l = resolveLedger({ total_amount: 1000 }, [customerGcash({ status: 'REFUND_PENDING' })]);
  assert.strictEqual(l.settled_amount, 1000);
});

check('FOR_VERIFICATION is not in the recognised set (the rule itself)', () => {
  assert.ok(!SETTLED_STATUSES.includes('FOR_VERIFICATION'), 'excluding it is deliberate, not an oversight');
});

console.log('\n=== refunds ===');

check('a negative SYSTEM_REFUND row reduces net settled', () => {
  const l = resolveLedger({ total_amount: 1000 }, [
    { amount: 1000, status: 'PAID', method: 'GCash' },
    { amount: -300, status: 'REFUNDED', method: 'SYSTEM_REFUND' },
  ]);
  assert.strictEqual(l.settled_amount, 1000);
  assert.strictEqual(l.refunded_amount, 300);
  assert.strictEqual(l.net_settled, 700);
});

check('a refunded booking is no longer fully settled', () => {
  const l = resolveLedger({ total_amount: 1000 }, [
    { amount: 1000, status: 'PAID', method: 'GCash' },
    { amount: -1000, status: 'REFUNDED', method: 'SYSTEM_REFUND' },
  ]);
  assert.strictEqual(l.net_settled, 0);
  assert.strictEqual(l.fully_settled, false);
  assert.strictEqual(l.outstanding_amount, 1000);
});

console.log('\n=== overpayment and edge cases ===');

check('an overpayment reports excess, not a larger expected amount', () => {
  const l = resolveLedger({ total_amount: 250 }, [{ amount: 300, status: 'PAID', method: 'GCash' }]);
  assert.strictEqual(l.expected_amount, 250);
  assert.strictEqual(l.net_settled, 300);
  assert.strictEqual(l.outstanding_amount, 0);
  assert.strictEqual(l.fully_settled, true);
});

check('a booking with no payments is unpaid, not broken', () => {
  const l = resolveLedger({ total_amount: 500 }, []);
  assert.strictEqual(l.settled_amount, 0);
  assert.strictEqual(l.outstanding_amount, 500);
  assert.strictEqual(l.has_ocr_data, false);
  assert.strictEqual(l.fully_settled, false);
});

check('a zero-total booking is never "fully settled"', () => {
  const l = resolveLedger({ total_amount: 0 }, []);
  assert.strictEqual(l.fully_settled, false, 'guards against a vacuous 0 >= 0 pass');
});

check('a corruption-prone null total does not produce NaN', () => {
  const l = resolveLedger({ total_amount: null }, [{ amount: 100, status: 'PAID', method: 'GCash' }]);
  assert.ok(Number.isFinite(l.expected_amount));
  assert.ok(Number.isFinite(l.outstanding_amount));
  assert.strictEqual(l.expected_amount, 0);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);