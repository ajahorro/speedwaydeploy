/**
 * tests/receipt_text_parser.test.js
 * ============================================================================
 * Regression tests for Tesseract-tolerant receipt parsing.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Receipt extraction moved from Gemini to Tesseract.js for speed. Gemini is an
 * LLM: it understands that "P2,SOO.OO" means ₱2,500.00. Tesseract reads pixels
 * and shapes, so it mangles exactly the characters a wallet receipt depends on:
 *
 *   ₱  ->  P, F, f          "₱2,500.00"  becomes "P2,500.00"
 *   0  ->  O, o             "1,080"      becomes "1,O8O"
 *   1  ->  l, I             "1,250"      becomes "l,250"
 *   5  ->  S                "2,500"      becomes "2,S00"
 *   8  ->  B                "1,080"      becomes "1,OB0"
 *   label letters -> digits "Total"      becomes "T0tal"
 *   ,  ->  .                "2,500"      becomes "2.500"
 *
 * Every case below is a defect that was OBSERVED while building the parser, not
 * a hypothetical. Each one previously produced a wrong or null amount, which the
 * server's amount gate (`extracted >= required - 1.00`) then turned into a
 * REJECTION of a payment that was actually correct.
 *
 * The parser is duplicated on both sides of the wire on purpose: the client's
 * parse is an untrusted hint, so the server re-parses the same text with its own
 * implementation. These tests run against BOTH and assert they agree.
 *
 * Run: node tests/receipt_text_parser.test.js
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
  const server = require('../backend/services/receiptTextParser');
  const client = await import('../frontend/src/utils/receiptOcr.js');

  // ── Harness guard ─────────────────────────────────────────────────────────
  // If either parser silently failed to load we would assert against `undefined`
  // and every test would throw for the wrong reason.
  check('harness: both parsers are loaded', () => {
    assert.strictEqual(typeof server.parseReceiptText, 'function');
    assert.strictEqual(typeof client.parseReceiptText, 'function');
  });

  const GCASH_CLEAN = [
    'GCash',
    'Sent to: COMAR GARAGE',
    'Total Amount Sent',
    'P2,500.00',
    'Reference No. 9021 334 887 221',
    'Jan 15, 2025',
  ].join('\n');

  const GCASH_MANGLED = [
    'GCash',
    'Sent to COMAR GARAGE',
    'T0tal Am0unt Sent',
    'P2,SOO.OO',
    'Reference No 9O2l33488722l',
    'Jan l5, 2O25',
  ].join('\n');

  console.log('=== the baseline: a clean GCash receipt ===');

  check('a clean receipt parses to the exact amount', () => {
    assert.strictEqual(server.parseReceiptText(GCASH_CLEAN).amount, 2500);
  });

  check('a clean receipt yields its reference and date', () => {
    const r = server.parseReceiptText(GCASH_CLEAN);
    assert.strictEqual(r.referenceNumber, '9021334887221');
    assert.strictEqual(r.timestamp, '2025-01-15');
  });

  console.log('\n=== THE REPORTED HAZARD: mangled wallet text ===');

  check('"P2,SOO.OO" (letter O for zero) still reads as 2500', () => {
    const r = server.parseReceiptText(GCASH_MANGLED);
    assert.strictEqual(r.amount, 2500, `expected 2500, got ${r.amount}`);
  });

  check('"T0tal Am0unt Sent" (digit zero for letter o) is still a label', () => {
    // Without label repair the label does not match, the amount is null, and the
    // server rejects a valid payment.
    assert.strictEqual(server.parseReceiptText(GCASH_MANGLED).grossAmount, 2500);
  });

  check('"Jan l5, 2O25" (letter l / letter O) still reads as a date', () => {
    assert.strictEqual(server.parseReceiptText(GCASH_MANGLED).timestamp, '2025-01-15');
  });

  check('a mangled numeric reference is repaired to digits', () => {
    // "9O2l33488722l" -> 9021334887221. Two scans of the SAME receipt must agree,
    // or the reference-reuse duplicate gate never fires.
    assert.strictEqual(server.parseReceiptText(GCASH_MANGLED).referenceNumber, '9021334887221');
  });

  console.log('\n=== the decimal-separator ambiguity ===');

  check('"2.500" is thousands, not 2 pesos 50', () => {
    // A 3-digit tail is a thousands group: no peso amount has 3 decimals.
    assert.strictEqual(server.parseAmountToken('2.500'), 2500);
    assert.strictEqual(server.parseAmountToken('2,500'), 2500);
  });

  check('"2,500.00" keeps its centavos', () => {
    assert.strictEqual(server.parseAmountToken('2,500.00'), 2500);
  });

  check('"P1,234.56" does not truncate to 1234', () => {
    // An earlier tokenizer matched only "P1,234" and under-read by 56 centavos.
    assert.strictEqual(server.parseAmountToken('P1,234.56'), 1234.56);
  });

  check('"1,250,000.00" handles multiple separators', () => {
    assert.strictEqual(server.parseAmountToken('1,250,000.00'), 1250000);
  });

  console.log('\n=== the label/value line split ===');

  check('a value on the NEXT line is found (GCash layout)', () => {
    const text = ['Total Amount Sent', 'P2,500.00'].join('\n');
    assert.strictEqual(server.parseReceiptText(text).grossAmount, 2500);
  });

  check('a value on the SAME line is found (Maya layout)', () => {
    const text = 'Total: P1,080.00';
    assert.strictEqual(server.parseReceiptText(text).grossAmount, 1080);
  });

  console.log('\n=== the gross / net / fee model ===');

  check('net = gross - fee when a fee line exists', () => {
    const text = [
      'Maya',
      'Total Amount Paid',
      'P1,110.00',
      'Transfer Fee 30.00',
    ].join('\n');
    const r = server.parseReceiptText(text);
    assert.strictEqual(r.grossAmount, 1110);
    assert.strictEqual(r.transferFee, 30);
    assert.strictEqual(r.amount, 1080, 'the shop receives the NET');
  });

  check('net equals gross when no fee line exists', () => {
    const text = ['GCash', 'Total Amount Sent', 'P980'].join('\n');
    const r = server.parseReceiptText(text);
    assert.strictEqual(r.grossAmount, 980);
    assert.strictEqual(r.transferFee, 0);
    assert.strictEqual(r.amount, 980);
  });

  console.log('\n=== false-positive guards (the "Total Amount Sent" -> 70 defect) ===');

  check('prose is never mistaken for money', () => {
    // "T0" from "Total" repairs to "70". A strict label line must reject it.
    const r = server.parseReceiptText('T0tal Am0unt Sent\nP2,SOO.OO');
    assert.strictEqual(r.grossAmount, 2500, 'the real figure must win, not 70');
  });

  check('a receipt with no amount yields null, not a guess', () => {
    assert.strictEqual(server.parseReceiptText('GCash\nThank you for using GCash').amount, null);
  });

  check('empty / null text does not throw', () => {
    assert.strictEqual(server.parseReceiptText('').amount, null);
    assert.strictEqual(server.parseReceiptText(null).amount, null);
    assert.strictEqual(server.parseReceiptText(undefined).isValidReceipt, false);
  });

  console.log('\n=== the date extractor must not stop at a junk candidate ===');

  check('a junk match before the real date does not discard it', () => {
    // The day-first pattern matched "00\nRef 9988" ("Ref" is not a month) and an
    // early-return implementation threw away the genuine "15 Jan 2025".
    const text = [
      'Maya',
      'Total Amount Paid',
      '2500',
      'Ref 998877665544',
      '15 Jan 2025',
    ].join('\n');
    assert.strictEqual(server.parseReceiptText(text).timestamp, '2025-01-15');
  });

  check('all common date shapes parse', () => {
    assert.strictEqual(server.extractDate('Jan 15, 2025'), '2025-01-15');
    assert.strictEqual(server.extractDate('January 15, 2025'), '2025-01-15');
    assert.strictEqual(server.extractDate('15 Jan 2025'), '2025-01-15');
    assert.strictEqual(server.extractDate('01/15/2025'), '2025-01-15');
    assert.strictEqual(server.extractDate('2025-01-15'), '2025-01-15');
  });

  check('a DD/MM date is not misread as MM/DD when the day exceeds 12', () => {
    assert.strictEqual(server.extractDate('25/12/2025'), '2025-12-25');
  });

  console.log('\n=== alphanumeric references must NOT be over-repaired ===');

  check('"ABC123456789" keeps its letters', () => {
    // Blindly rewriting B -> 8 produced "A8C123456789", so two scans of the same
    // receipt gave different references and the duplicate gate never fired.
    const text = ['GCash', 'To: COMAR GARAGE', 'Total: P1,080.00', 'Ref No: ABC123456789'].join('\n');
    assert.strictEqual(server.parseReceiptText(text).referenceNumber, 'ABC123456789');
  });

  check('a digit-dominant reference IS repaired', () => {
    const text = ['GCash', 'Total: P1,080.00', 'Ref No 9O2l33488722l'].join('\n');
    assert.strictEqual(server.parseReceiptText(text).referenceNumber, '9021334887221');
  });

  console.log('\n=== the recipient name ===');

  check('"Sent to" yields the payee', () => {
    assert.strictEqual(server.extractRecipient('Sent to: COMAR GARAGE'), 'COMAR GARAGE');
  });

  check('"Send Money to" (Maya) yields the payee', () => {
    assert.strictEqual(server.extractRecipient('Send Money to COMAR GARAGE'), 'COMAR GARAGE');
  });

  // ── The "tal Amount Sent" defect ───────────────────────────────────────────
  // The label alternation originally included a bare `to`, which matched the `to`
  // INSIDE "Total". The amount label line was then parsed as the payee, the
  // server's fail-fast name gate compared garbage against the shop name, and a
  // valid payment was rejected with NAME_MISMATCH.
  check('the amount label is NOT mistaken for the payee', () => {
    const text = ['GCash', 'Total Amount Sent', 'PHP 2,500.00'].join('\n');
    assert.strictEqual(server.extractRecipient(text), null, 'a label line must not yield a payee');
  });

  check('a payee on the NEXT line is found (GCash split layout)', () => {
    const text = ['GCash', 'Sent to', 'COMAR GARAGE', 'Total Amount Sent', 'PHP 2,500.00'].join('\n');
    assert.strictEqual(server.extractRecipient(text), 'COMAR GARAGE');
  });

  check('the capture is the NAME, never the label itself', () => {
    // A group-index regression captured the literal string "Sent to".
    const text = ['Sent to', 'COMAR GARAGE'].join('\n');
    const recipient = server.extractRecipient(text);
    assert.notStrictEqual(recipient, 'Sent to');
    assert.ok(!/^(sent|send|paid|transferred)\b/i.test(recipient || ''), 'the label must never be returned');
  });

  check('a standalone "To" still works (the boundary fix did not break it)', () => {
    assert.strictEqual(server.extractRecipient('To: COMAR GARAGE'), 'COMAR GARAGE');
  });

  console.log('\n=== receipt detection ===');

  check('a real receipt is recognised', () => {
    assert.strictEqual(server.looksLikeReceipt(GCASH_CLEAN), true);
  });

  check('a random photo is not recognised as a receipt', () => {
    assert.strictEqual(server.looksLikeReceipt('A photo of a cat sitting on a sofa'), false);
  });

  console.log('\n=== CLIENT and SERVER must agree ===');

  // The client's parse is an untrusted hint and the server re-parses the same
  // text. If the two implementations diverge, one of them has a bug — and the
  // divergence would be invisible in production, because the server silently
  // wins. Comparing them here is the only place that divergence surfaces.
  check('both parsers produce identical results on every sample', () => {
    const samples = {
      clean: GCASH_CLEAN,
      mangled: GCASH_MANGLED,
      thousands: ['Maya', 'Send Money to COMAR GARAGE', 'Total Amount Paid', '2.500', 'Transfer Fee 25.00', 'Ref 1234567890', '01/15/2025'].join('\n'),
      decimals: ['GCash', 'Sent to COMAR GARAGE', 'Total Amount Sent', 'P1,234.56', 'Transfer Fee 12.34', 'Reference No. 555111222333', 'Dec 3, 2025'].join('\n'),
      alnumRef: ['GCash', 'To: COMAR GARAGE', 'Total: P1,080.00', 'Ref No: ABC123456789', '15 Jan 2025'].join('\n'),
      noFee: ['GCash', 'Sent to COMAR GARAGE', 'Total Amount Sent', 'P980', 'Reference No. 1234567890123', 'Jan 15, 2025'].join('\n'),
    };

    for (const [name, text] of Object.entries(samples)) {
      const s = server.parseReceiptText(text);
      const c = client.parseReceiptText(text);
      for (const field of ['amount', 'grossAmount', 'transferFee', 'referenceNumber', 'timestamp', 'recipient', 'isValidReceipt']) {
        assert.deepStrictEqual(
          c[field], s[field],
          `[${name}] ${field} diverged: client=${JSON.stringify(c[field])} server=${JSON.stringify(s[field])}`
        );
      }
    }
  });

  console.log('\n=== the amount gate the parser feeds ===');

  check('a repaired amount passes the server floor check', () => {
    // The gate is `extracted >= required - 1.00`. The mangled ₱2,500 receipt must
    // clear a ₱2,500 requirement once repaired.
    const required = 2500;
    const extracted = server.parseReceiptText(GCASH_MANGLED).amount;
    assert.ok(extracted >= required - 1.0, `₱${extracted} must satisfy the ₱${required} requirement`);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();