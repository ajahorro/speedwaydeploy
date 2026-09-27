/**
 * tests/ocr_and_financial_edge_cases.test.js
 * ============================================================================
 * Real-world edge cases for the OCR parser AND the financial calculation flows.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Two independent areas, both "source of truth" concerns:
 *
 *   PART 1 — OCR PARSING EDGE CASES
 *     Tesseract reads pixels, and Philippine wallet receipts are hostile to it:
 *     mixed currency symbols, several date conventions, and — the classic trap —
 *     decimals that vanish or shift by a factor of 100. Each case below was run
 *     against the live parser; the ones marked DEFECT previously failed.
 *
 *   PART 2 — FINANCIAL CALCULATION FLOWS
 *     A receipt is only as good as the numbers it is checked against. This part
 *     traces (a) how a booking's total is computed from packages/promos and
 *     persisted, and (b) how a subsequent payment updates the balance instead of
 *     overwriting it.
 *
 * The parsers are duplicated on both sides of the wire (client hint vs server
 * authority), so every parsing assertion runs against BOTH and requires them to
 * agree. A divergence is invisible in production — the server silently wins —
 * which is exactly why it is asserted here.
 *
 * Run: node tests/ocr_and_financial_edge_cases.test.js
 * ============================================================================
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/**
 * Strip comments so an assertion about CODE is not tripped by a COMMENT.
 *
 * This matters more than it looks: each file that had VAT removed carries a note
 * explaining the removal ("there is no VAT (12%) line"). A word-match assertion
 * over the raw source flags those explanations and reports a false failure — and
 * a security/correctness test that cries wolf is a test people learn to ignore.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\/.*$/gm, '');

const server = require('../backend/services/receiptTextParser');

(async () => {
  const client = await import('../frontend/src/utils/receiptOcr.js');

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // ── Harness guard ─────────────────────────────────────────────────────────
  check('harness: both parsers are loaded', () => {
    assert.strictEqual(typeof server.parseAmountToken, 'function');
    assert.strictEqual(typeof client.parseAmountToken, 'function');
  });

  console.log('\n=== PART 1a: MULTI-CURRENCY / SYMBOL VARIANTS ===');

  // Every variant must yield 2500. `null` here means the receipt is rejected.
  const CURRENCY_VARIANTS = {
    'PHP 2,500.00': 2500,
    'Php 2,500.00': 2500,
    'php 2,500.00': 2500,
    'PHP2,500.00': 2500,
    'P2,500.00': 2500,
    'P 2,500.00': 2500,
    '₱2,500.00': 2500,
    '2,500.00': 2500,
    'P2500': 2500,
    'PHP 2500': 2500,
    '2500': 2500,
    '₱2500': 2500,
  };

  for (const [input, expected] of Object.entries(CURRENCY_VARIANTS)) {
    check(`"${input}" -> ${expected}`, () => {
      assert.strictEqual(server.parseAmountToken(input), expected);
      assert.strictEqual(client.parseAmountToken(input), expected, 'client must agree');
    });
  }

  check('a currency variant is found in a realistic label/value block', () => {
    for (const symbol of ['PHP', 'Php', 'P', '₱', '']) {
      const text = ['GCash', 'Sent to', 'COMAR GARAGE', 'Total Amount Sent', `${symbol} 2,500.00`.trim()].join('\n');
      assert.strictEqual(
        server.parseReceiptText(text).grossAmount, 2500,
        `'${symbol}' must resolve to 2500`
      );
    }
  });

  check('a receipt with NO currency symbol still parses', () => {
    const text = ['GCash', 'Total Amount Sent', '2,500.00', 'Ref 1234567890'].join('\n');
    assert.strictEqual(server.parseReceiptText(text).grossAmount, 2500);
  });

  console.log('\n=== PART 1b: EDGE-CASE DATE FORMATS ===');

  const DATE_CASES = {
    'Jan 15, 2026': '2026-01-15',
    'January 15, 2026': '2026-01-15',
    'Jan. 15, 2026': '2026-01-15',
    'Jan 15 2026': '2026-01-15',
    '15 Jan 2026': '2026-01-15',
    '15 January 2026': '2026-01-15',
    '15/01/2026': '2026-01-15',
    '01/15/2026': '2026-01-15',
    '15-01-2026': '2026-01-15',
    '2026-01-15': '2026-01-15',
    '2026-01-15T14:30:00Z': '2026-01-15',
    '01/15/2026 14:30:00': '2026-01-15',
    'Jan 15, 2026 2:47 PM': '2026-01-15',
    'Mar 9, 2026 09:05 PM': '2026-03-09',
    'Dec 3, 2026': '2026-12-03',
  };

  for (const [input, expected] of Object.entries(DATE_CASES)) {
    check(`date "${input}" -> ${expected}`, () => {
      assert.strictEqual(server.extractDate(input), expected);
      assert.strictEqual(client.extractDate(input), expected, 'client must agree');
    });
  }

  check('an ambiguous DD/MM is read as day-first when the day exceeds 12', () => {
    // 25 cannot be a month, so this is unambiguously 25 December.
    assert.strictEqual(server.extractDate('25/12/2026'), '2026-12-25');
  });

  check('a date is always ISO YYYY-MM-DD, never a locale string', () => {
    // The DB column is a date; a locale string would fail the cast.
    const iso = server.extractDate('Jan 15, 2026 2:47 PM');
    assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
  });

  console.log('\n--- IMPOSSIBLE DATES (the "Feb 30" defect) ---');

  check('"Feb 30, 2026" is REJECTED, not rolled over to March 2', () => {
    // DEFECT: the day was range-checked 1..31 with no month reference, so
    // "Feb 30, 2026" produced "2026-02-30". `new Date()` then silently rolled it
    // to March 2, which sat inside the ±24h tolerance window and PASSED the date
    // gate — clearing a validation control with a date that does not exist.
    assert.strictEqual(server.extractDate('Feb 30, 2026'), null);
  });

  check('other impossible dates are rejected too', () => {
    assert.strictEqual(server.extractDate('Apr 31, 2026'), null);
    assert.strictEqual(server.extractDate('Feb 29, 2026'), null, '2026 is not a leap year');
    assert.strictEqual(server.extractDate('2026-02-30'), null);
  });

  check('a REAL leap day is still accepted', () => {
    // The fix must not be a blanket ban on Feb 29.
    assert.strictEqual(server.extractDate('Feb 29, 2028'), '2028-02-29');
    assert.strictEqual(server.extractDate('Feb 28, 2026'), '2026-02-28');
  });

  check('month-end boundaries are respected', () => {
    assert.strictEqual(server.extractDate('Apr 30, 2026'), '2026-04-30');
    assert.strictEqual(server.extractDate('Jan 31, 2026'), '2026-01-31');
    assert.strictEqual(server.extractDate('Jun 31, 2026'), null, 'June has 30 days');
  });

  console.log('\n=== PART 1c: THE DECIMAL SEPARATOR TRAP ===');

  // The classic Tesseract failure: 25.00 read as 2500 (×100). Every value below
  // is asserted exactly — an order-of-magnitude error must not pass silently.
  const DECIMAL_CASES = {
    '2500.00': 2500,
    '2,500.00': 2500,
    '2,500': 2500,
    '2500': 2500,
    '25.00': 25,
    '250.00': 250,
    '25.50': 25.5,
    '2,500.50': 2500.5,
    '2,500.5': 2500.5,
    '0.50': 0.5,
    '12.5': 12.5,
    '1.5': 1.5,
    '1,234,567.89': 1234567.89,
  };

  for (const [input, expected] of Object.entries(DECIMAL_CASES)) {
    check(`decimal "${input}" -> ${expected} (no ×100 drift)`, () => {
      const got = server.parseAmountToken(input);
      assert.strictEqual(got, expected, `expected ${expected}, got ${got}`);
      assert.strictEqual(client.parseAmountToken(input), expected, 'client must agree');
    });
  }

  check('"25.00" does NOT become 2500 (the ×100 Tesseract bug)', () => {
    assert.notStrictEqual(server.parseAmountToken('25.00'), 2500);
    assert.strictEqual(server.parseAmountToken('25.00'), 25);
  });

  check('"2.500" is thousands (2500), because a 3-digit tail is never centavos', () => {
    // No peso amount is printed with 3 decimals, whereas thousands groups are
    // always 3 digits.
    assert.strictEqual(server.parseAmountToken('2.500'), 2500);
  });

  check('a whole number keeps no phantom decimals', () => {
    assert.strictEqual(server.parseAmountToken('₱2,500'), 2500);
    assert.strictEqual(server.parseAmountToken('P2500'), 2500);
  });

  check('centavos are preserved exactly, not truncated or rounded away', () => {
    // A strict amount gate (`>= required - 1.00`) turns a lost 56 centavos into a
    // rejection on a tight booking.
    assert.strictEqual(server.parseAmountToken('P1,234.56'), 1234.56);
    assert.strictEqual(server.parseAmountToken('₱99.99'), 99.99);
    assert.strictEqual(server.parseAmountToken('0.01'), 0.01);
  });

  check('the gross/net/fee arithmetic never loses a centavo', () => {
    // gross - fee must equal net exactly, with no floating-point residue.
    const text = ['GCash', 'Total Amount Sent', 'P1,234.56', 'Transfer Fee 12.34'].join('\n');
    const r = server.parseReceiptText(text);
    assert.strictEqual(r.grossAmount, 1234.56);
    assert.strictEqual(r.transferFee, 12.34);
    assert.strictEqual(r.amount, round2(1234.56 - 12.34));
    assert.strictEqual(r.amount, 1222.22);
  });

  const { resolveTransactionAmounts, buildAmountSentence } = await import('../frontend/src/utils/paymentAmounts.js');

  console.log('\n=== PART 2a: BOOKING CREATION CALCULATION FLOW ===');

  const { calculateBookingDiscountSummary } =
    await import('../frontend/src/data/servicesCatalog.js');

  // A plain two-service Sedan booking: Regular Wash ₱150 + Engine Wash ₱500.
  const PLAIN_BOOKING = [
    { type: 'Sedan', services: [
      { name: 'Regular Wash', price: 150 },
      { name: 'Engine Wash', price: 500 },
    ] },
  ];

  check('a plain booking totals the sum of its service prices', () => {
    const summary = calculateBookingDiscountSummary(PLAIN_BOOKING);
    assert.strictEqual(summary.discountedTotal, 650, '150 + 500');
    assert.strictEqual(summary.originalTotal, 650);
    assert.strictEqual(summary.totalDiscount, 0, 'no promo, no discount');
  });

  check('the persisted total is an exact number (no float residue)', () => {
    // 0.1 + 0.2 style drift would be stored as 650.0000000000001 and would then
    // never equal a receipt total in a strict comparison.
    const summary = calculateBookingDiscountSummary([
      { type: 'Sedan', services: [{ name: 'A', price: 0.1 }, { name: 'B', price: 0.2 }] },
    ]);
    assert.strictEqual(round2(summary.discountedTotal), 0.3);
  });

  check('a package replaces its members with ONE flat price', async () => {
    // A package is a PRODUCT, not a discount: the vehicle is charged the bundle
    // price and the individual lines are not summed.
    const store = {};
    globalThis.window = { localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } } };
    globalThis.localStorage = globalThis.window.localStorage;
    store['speedway_promo_rules'] = JSON.stringify([{
      id: 'pkg-test', name: 'Test Bundle', mode: 'package', type: 'fixed_package',
      value: 500, validFrom: '2020-01-01T00:00', neverExpires: true,
      vehicleServiceMatrix: { Sedan: ['Regular Wash', 'Engine Wash'] },
    }]);

    // Re-import so the freshly-seeded localStorage is visible.
    const fresh = await import('../frontend/src/data/servicesCatalog.js');
    const summary = fresh.calculateBookingDiscountSummary([
      { type: 'Sedan', services: [{ name: 'Regular Wash', price: 150 }, { name: 'Engine Wash', price: 500 }] },
    ]);
    assert.strictEqual(summary.discountedTotal, 500, 'the flat bundle price wins');
    assert.strictEqual(summary.originalTotal, 650, 'the standalone sum is still reported');
    assert.strictEqual(summary.totalDiscount, 150, 'the saving is the difference');
    assert.strictEqual(summary.appliedPackages.length, 1);
    assert.strictEqual(summary.appliedPackages[0].packagePrice, 500);
  });

  check('a package never stacks with a standard promo (no double-discount)', () => {
    // Double-discounting a bundle would under-charge the shop.
    const summary = calculateBookingDiscountSummary([
      { type: 'Sedan', services: [{ name: 'Regular Wash', price: 150 }, { name: 'Engine Wash', price: 500 }] },
    ]);
    assert.strictEqual(summary.discountedTotal, 500, 'bundle price only, no extra % off');
  });

  check('pricing is FLAT and TAX-FREE (no tax split, no inflation)', () => {
    // VAT has been removed from the system entirely. The quoted price IS the
    // charged price IS the stored price. This replaces the old "VAT split sums
    // back to the gross" assertion, which pinned a tax model that no longer
    // exists — and which had itself been the source of a receipt/DB mismatch.
    for (const price of [2500, 1080, 980, 1234.56, 0.5, 1000000]) {
      const a = resolveTransactionAmounts({ total_amount: price }, null);
      assert.strictEqual(a.totalDue, price, `the amount due must BE the price (${price})`);
      assert.ok(!('vatIncluded' in a), 'no tax may be extracted from the price');
      assert.ok(!('vatExclusiveSales' in a), 'no tax-exclusive base may be derived');
    }
  });

  check('the OfficialReceipt component applies NO tax', () => {
    // DEFECT (now fixed): the receipt once ADDED 12% on top, so a ₱2,500 booking
    // rendered a "Total Amount Due" of ₱2,800 — a figure never charged and absent
    // from the database. It was then aligned to an inclusive split, and now the
    // tax concept is gone altogether.
    //
    // Comments are stripped: the file explains that both models were removed.
    const receipt = stripComments(read('frontend/src/components/OfficialReceipt.jsx'));
    assert.ok(
      !/VAT_RATE/.test(receipt),
      'the receipt must not reference a tax rate at all'
    );
    assert.ok(
      !/vatableSales/.test(receipt),
      'the receipt must not derive a tax-exclusive base'
    );
    assert.ok(
      !/\/\s*\(1\s*\+\s*VAT_RATE\)|\/\s*1\.12/.test(receipt),
      'the receipt must not divide by a tax divisor'
    );
  });

  check('the receipt renders no Vatable Sales / VAT line items', () => {
    // Comments are stripped first. The file deliberately EXPLAINS that the
    // "Vatable Sales" / "VAT (12%)" rows were removed, so a naive word-match
    // flags the explanation itself — the same false-positive trap as the
    // concurrency guard test.
    const receipt = stripComments(read('frontend/src/components/OfficialReceipt.jsx'));
    assert.ok(!/Vatable Sales/i.test(receipt), 'the "Vatable Sales" row must be gone');
    assert.ok(!/VAT \(12%\)/i.test(receipt), 'the "VAT (12%)" row must be gone');
  });

  check('the receipt total is the flat price, with no tax term', () => {
    // The receipt must never show a total that differs from what was charged.
    const receipt = read('frontend/src/components/OfficialReceipt.jsx');
    assert.ok(/const total = round2\(gross\)/.test(receipt), 'Total Amount Due must be the price');
  });

  check('no email or print template renders a VAT line', () => {
    // Every surface that prints money must agree: the on-screen receipt, the
    // emailed receipt, the lifecycle PDF, and the print popups.
    //
    // Comments are stripped, because each of these files carries a note
    // explaining that VAT was removed — matching the note would be a false alarm.
    const surfaces = [
      'backend/server.js',
      'supabase/functions/_shared/bookingEmail.ts',
      'supabase/functions/booking-lifecycle/index.ts',
      'frontend/src/pages/Customer/CustomerBilling.jsx',
      'frontend/src/pages/Customer/CustomerBookingDetails.jsx',
      'frontend/src/pages/Admin/AdminPayments.jsx',
    ];
    for (const file of surfaces) {
      const src = stripComments(read(file));
      assert.ok(!/VAT \(12%/.test(src), `${file} must not print a VAT line`);
      assert.ok(!/vatIncluded|vatExclusiveSales/.test(src), `${file} must not reference a VAT field`);
      assert.ok(!/\/\s*1\.12/.test(src), `${file} must not divide by a tax divisor`);
    }
  });

  console.log('\n=== PART 2b: ADDITIONAL PAYMENT / SUB-BOOKING FLOW ===');

  check('a first payment against an unpaid booking leaves the correct balance', () => {
    const amounts = resolveTransactionAmounts({ total_amount: 2500 }, { amount: 1000, status: 'PAID' });
    assert.strictEqual(amounts.bookingTotal, 2500);
    assert.strictEqual(amounts.grossPaid, 1000);
    assert.strictEqual(amounts.creditedToBooking, 1000);
    assert.strictEqual(amounts.remainingBalance, 1500, '₱2,500 - ₱1,000');
  });

  check('a SECOND payment updates the balance; it does not overwrite the total', () => {
    // The defect this guards: recomputing from only the newest payment row would
    // show the booking as fully paid after a ₱1,000 top-up, or reset the balance.
    //
    // NOTE the contract: resolveTransactionAmounts() resolves ONE payment against
    // the IMMUTABLE booking total. It is stateless — it does not know about other
    // payment rows — so each call reports the balance as if that payment were the
    // only one. Cumulative balance is the LEDGER's job, not this function's. The
    // guarantee under test is that neither call mutates the booking total.
    const first = resolveTransactionAmounts({ total_amount: 2500 }, { amount: 1000, status: 'PAID' });
    const second = resolveTransactionAmounts({ total_amount: 2500 }, { amount: 1500, status: 'PAID' });

    assert.strictEqual(second.bookingTotal, 2500, 'the booking total is never mutated by a payment');
    assert.strictEqual(first.bookingTotal, second.bookingTotal, 'both calls see the same total');
    assert.strictEqual(first.creditedToBooking, 1000, 'the first payment credits its own amount');
    assert.strictEqual(second.creditedToBooking, 1500, 'the second credits its own amount');
    assert.strictEqual(first.remainingBalance, 1500, '₱2,500 - ₱1,000');
    assert.strictEqual(second.remainingBalance, 1000, '₱2,500 - ₱1,500');
  });

  check('the ledger sums payments correctly across a partial-payment sequence', () => {
    // The end-to-end guarantee: a deposit plus a top-up must settle the booking
    // exactly, with no residual balance and no over-credit. This models what the
    // payments table accumulates rather than what one call returns.
    const bookingTotal = 2500;
    const payments = [1000, 1500];
    const totalCredited = payments.reduce(
      (sum, amount) => sum + resolveTransactionAmounts({ total_amount: bookingTotal }, { amount, status: 'PAID' }).creditedToBooking,
      0
    );
    assert.strictEqual(totalCredited, bookingTotal, 'the two payments settle ₱2,500 exactly');
    assert.strictEqual(Math.max(0, bookingTotal - totalCredited), 0, 'no residual balance');
  });

  check('the booking total is READ-ONLY across every payment', () => {
    // If a payment could change `bookingTotal`, the ledger would drift.
    for (const paid of [0, 500, 2500, 9999]) {
      const a = resolveTransactionAmounts({ total_amount: 2500 }, { amount: paid, status: 'PAID' });
      assert.strictEqual(a.bookingTotal, 2500, `a ₱${paid} payment must not alter the booking total`);
    }
  });

  check('an overpayment is banked as credit, not treated as a mismatch', () => {
    const a = resolveTransactionAmounts({ total_amount: 2500 }, { amount: 3000, status: 'PAID' });
    assert.strictEqual(a.excessCredit, 500);
    assert.strictEqual(a.remainingBalance, 0, 'nothing is still owed');
  });

  check('a transfer fee is not a shortfall (the customer paid it)', () => {
    // The bank kept the fee in transit; the customer still covered the booking.
    const a = resolveTransactionAmounts(
      { total_amount: 2500 },
      { detected_amount: 2480, transfer_fee: 20, status: 'PAID' }
    );
    assert.strictEqual(a.netReceived, 2480, 'the shop received the net');
    assert.strictEqual(a.grossPaid, 2500, 'the customer sent the gross');
    assert.strictEqual(a.creditedToBooking, 2500, 'the full gross credits the booking');
    assert.strictEqual(a.remainingBalance, 0, 'the fee must NOT create a phantom balance');
  });

  check('a partial payment is reflected in the parts breakdown', () => {
    const a = resolveTransactionAmounts({ total_amount: 2500 }, { amount: 1000, status: 'PAID' });
    const labels = a.parts.map((p) => p.label);
    assert.ok(labels.includes('Amount Paid'));
    assert.ok(labels.includes('Balance Still Due'), 'a part-paid booking shows a balance line');
    const balanceLine = a.parts.find((p) => p.label === 'Balance Still Due');
    assert.strictEqual(balanceLine.amount, 2500, 'the line states the booking total');
  });

  check('the amount sentence never contradicts the parts table', () => {
    // The module is already imported above; `check` callbacks are synchronous, so
    // this must not await inside the callback.
    const partial = resolveTransactionAmounts({ total_amount: 2500 }, { amount: 1000, status: 'PAID' });
    const sentence = buildAmountSentence(partial);
    assert.ok(/balance/i.test(sentence), 'a partial payment must mention the remaining balance');
    assert.ok(sentence.includes('1,500') || sentence.includes('1500'), 'and state it correctly');
  });

  check('a zero-amount payment cannot silently settle a booking', () => {
    const a = resolveTransactionAmounts({ total_amount: 2500 }, { amount: 0, status: 'PAID' });
    assert.strictEqual(a.creditedToBooking, 0);
    assert.strictEqual(a.remainingBalance, 2500, 'the full amount is still owed');
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();