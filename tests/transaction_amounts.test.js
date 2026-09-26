/**
 * tests/transaction_amounts.test.js
 * ============================================================================
 * Locks in the money model that the receipt email, the receipt PDF and the
 * lifecycle email all render from.
 *
 * These assertions exist because the defects they cover were SILENT: the emails
 * looked plausible, but a ₱250 payment produced a receipt demanding ₱280 (12%
 * VAT added to a VAT-inclusive price), and the receipt quoted a different
 * figure from the lifecycle email for the same payment.
 *
 * Run: node tests/transaction_amounts.test.js
 * ============================================================================
 */
const assert = require('assert');
const { resolveTransactionAmounts, reconcileOcrAmounts } = require('../backend/services/transactionAmounts');

const round2 = (n) => Math.round(n * 100) / 100;

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

console.log('=== transaction amount model ===');

// ── The exact bug the customer reported: ₱250 paid, ₱250 booking ─────────────
check('plain full payment quotes ₱250, NOT ₱280 (no VAT added on top)', () => {
  const a = resolveTransactionAmounts(
    { total_amount: 250 },
    { amount: 250, method: 'GCash', status: 'PAID' }
  );
  assert.strictEqual(a.totalDue, 250, 'booking total must be the paid amount');
  assert.strictEqual(a.grossPaid, 250);
  assert.strictEqual(a.netReceived, 250);
  assert.strictEqual(a.remainingBalance, 0);
  assert.strictEqual(a.excessCredit, 0);
  // VAT is EXTRACTED from a VAT-inclusive 250 (Philippines: 12%), never added
  // on top. The figures are derived in tests/vat_split.test.js from the tax rule
  // itself, so this file only asserts the property that matters here.
  assert.ok(a.vatIncluded < 250, 'VAT must be part of the total, never on top of it');
  assert.strictEqual(round2(a.vatExclusiveSales + a.vatIncluded), 250, 'base + VAT must equal the total');
});

// ── OCR returns the NET the shop received; the customer paid the GROSS ───────
check('transfer fee: gross = net + fee, and gross is what the customer is shown', () => {
  const a = resolveTransactionAmounts(
    { total_amount: 500 },
    { amount: 500, detected_amount: 480, transfer_fee: 20, status: 'PAID' }
  );
  assert.strictEqual(a.netReceived, 480, 'shop received the net after the fee');
  assert.strictEqual(a.grossPaid, 500, 'customer sent the gross');
  assert.strictEqual(a.remainingBalance, 0, 'a fee must not make the booking read as short-paid');
});

// ── OCR disagreed with the declared amount ──────────────────────────────────
check('OCR net outranks the declared amount as the received figure', () => {
  const a = resolveTransactionAmounts(
    { total_amount: 500 },
    { amount: 500, detected_amount: 450, status: 'FOR_VERIFICATION' }
  );
  assert.strictEqual(a.netReceived, 450, 'OCR truth wins over the declaration');
  assert.strictEqual(a.remainingBalance, 50, 'true shortfall is surfaced, not hidden');
});

check('OCR amount is the paid figure when the submitted amount is stale', () => {
  const a = resolveTransactionAmounts(
    { total_amount: 10000 },
    { amount: 3000, detected_amount: 10000, transfer_fee: 0, status: 'PAID' }
  );
  assert.strictEqual(a.grossPaid, 10000);
  assert.strictEqual(a.creditedToBooking, 10000);
  assert.strictEqual(a.remainingBalance, 0);
});

// ── Downpayment: the receipt must not claim "paid in full" ──────────────────
check('partial payment reports the outstanding balance', () => {
  const a = resolveTransactionAmounts(
    { total_amount: 1000 },
    { amount: 250, status: 'PAID' }
  );
  assert.strictEqual(a.netApplied, 250);
  assert.strictEqual(a.remainingBalance, 750);
  assert.strictEqual(a.excessCredit, 0);
});

// ── Overpayment ─────────────────────────────────────────────────────────────
check('overpayment is reported as excess credit, not as a larger total', () => {
  const a = resolveTransactionAmounts(
    { total_amount: 250 },
    { amount: 300, status: 'PAID' }
  );
  assert.strictEqual(a.excessCredit, 50);
  assert.strictEqual(a.remainingBalance, 0, 'an overpayment never leaves a balance');
  assert.strictEqual(a.totalDue, 250, 'the booking total does not grow to match the payment');
});

// ── Credit absorbed from the ledger ─────────────────────────────────────────
check('excess credit applied to the booking counts toward the amount due', () => {
  const a = resolveTransactionAmounts(
    { total_amount: 500 },
    { amount: 300, credit_applied: 200, status: 'PAID' }
  );
  assert.strictEqual(a.netApplied, 500);
  assert.strictEqual(a.remainingBalance, 0);
});

// ── A booking with no payment must still render ─────────────────────────────
check('booking with no payment renders without inventing money', () => {
  const a = resolveTransactionAmounts({ total_amount: 250 }, null);
  assert.strictEqual(a.bookingTotal, 250);
  assert.strictEqual(a.grossPaid, 0);
  assert.strictEqual(a.remainingBalance, 250);
  assert.strictEqual(a.hasPayment !== false, true);
});

console.log('\n=== OCR vs recorded reconciliation ===');

check('matching amounts report no mismatch', () => {
  const r = reconcileOcrAmounts(500, 500);
  assert.strictEqual(r.matches, true);
  assert.strictEqual(r.difference, 0);
});

check('sub-tolerance rounding is not treated as a mismatch', () => {
  const r = reconcileOcrAmounts(500, 500.5, 1);
  assert.strictEqual(r.matches, true, '₱0.50 of rounding is noise, not a defect');
});

check('a small real discrepancy is flagged minor', () => {
  const r = reconcileOcrAmounts(500, 480);
  assert.strictEqual(r.matches, false);
  assert.strictEqual(r.severity, 'minor', '4% off is worth logging, not escalating');
});

check('a large discrepancy is flagged major', () => {
  const r = reconcileOcrAmounts(1000, 400);
  assert.strictEqual(r.matches, false);
  assert.strictEqual(r.severity, 'major');
});

check('no OCR figure means nothing to reconcile', () => {
  const r = reconcileOcrAmounts(500, 0);
  assert.strictEqual(r.matches, true, 'a cash payment has no OCR reading');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);