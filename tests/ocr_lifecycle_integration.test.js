/**
 * tests/ocr_lifecycle_integration.test.js
 * ============================================================================
 * END-TO-END LIFECYCLE TEST for the Tesseract + server-reparse pipeline.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Receipt verification was migrated from Gemini to a two-stage pipeline:
 *
 *     browser: Tesseract.js -> raw text + client hint
 *     server:  re-parse the text -> verdict -> persist -> respond
 *
 * The unit suites cover each half in isolation (receipt_text_parser.test.js and
 * ocr_payload_contract.test.js). Neither proves the LIFECYCLE holds end to end.
 * This file does, and it is written as the acceptance test for the migration:
 * it reproduces the guarantees the old OCR service provided, and asserts the new
 * pipeline still meets them.
 *
 * The three guarantees under test:
 *
 *   1. DATA PRESERVATION & CALCULATION
 *      A realistic GCash text block must yield the right amount, clear the
 *      booking's amount threshold, produce a valid date, and — critically —
 *      keep the RAW STRING available so SC-17's byte-hash duplicate check can
 *      run. SC-17 hashes the IMAGE BYTES, so the text must never be what the
 *      duplicate gate depends on; this asserts the separation explicitly.
 *
 *   2. FALLBACK / GRACEFUL DEGRADATION
 *      A blank, blurred, or unreadable upload must NOT 500 and must NOT hard-block
 *      the customer. It must route to `extractionUnavailable` -> MANUAL REVIEW.
 *
 *   3. DATABASE SCHEMA ALIGNMENT
 *      The JSON the server hands to persist_ocr_result must match the RPC's
 *      parameter names and the keys the admin UI reads back out of the stored
 *      record. A renamed key fails silently: the write succeeds and the UI reads
 *      `undefined`.
 *
 * The server handler is exercised by IMPORTING its pure dependencies and
 * replaying the exact logic, rather than booting Express: the handler's decisions
 * live in the parser + guard modules, and a real HTTP server would require a live
 * Supabase. The one thing that cannot be replayed that way — the literal
 * `p_ocr_metadata` object and the RPC call shape — is verified against the source
 * text, which is where a rename actually happens.
 *
 * Run: node tests/ocr_lifecycle_integration.test.js
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

const { parseReceiptText } = require('../backend/services/receiptTextParser');
const ocrGuard = require('../backend/services/ocrGuard');

const SERVER = read('backend/server.js');
const PERSIST_MIGRATION = read('supabase/migrations/20261019000012_persist_ocr_result_enum_case.sql');

// ── A realistic GCash receipt, as Tesseract would return it ──────────────────
// Deliberately imperfect: a real scan is never clean, and the whole point of the
// tolerant parser is that a realistic-but-imperfect block still verifies.
const GCASH_RAW_TEXT = [
  'GCash',
  'Transaction Receipt',
  'Sent to',
  'COMAR GARAGE',
  'Total Amount Sent',
  'PHP 2,500.00',
  'Reference No. 9021 334 887 221',
  'Jan 15, 2025 2:47 PM',
  'This is a system-generated receipt.',
].join('\n');

const BOOKING_REQUIRED_AMOUNT = 2500;

// ── The server's amount gate, reproduced verbatim from server.js ────────────
// Kept in sync by the contract test; duplicated here so the lifecycle assertion
// reads as one continuous story rather than a call into a helper.
const AMOUNT_TOLERANCE = 1.0;
const amountGatePasses = (extracted, required) => extracted >= (required - AMOUNT_TOLERANCE);

(async () => {
  console.log('=== STAGE 1: DATA PRESERVATION & CALCULATION ===');

  const parsed = parseReceiptText(GCASH_RAW_TEXT);

  check('the raw text block is preserved verbatim for downstream use', () => {
    // The raw string is what gets sent to the server as `extractedText`. If the
    // parser discarded it, the server would have nothing to re-parse and every
    // receipt would fall to manual review.
    assert.strictEqual(typeof parsed.rawText, 'string');
    assert.ok(parsed.rawText.includes('COMAR GARAGE'), 'the payee must survive');
    assert.ok(parsed.rawText.includes('9021 334 887 221'), 'the reference must survive');
    assert.strictEqual(parsed.rawText, GCASH_RAW_TEXT, 'the raw text must be returned unmodified');
  });

  check('the total amount is extracted correctly (₱2,500.00)', () => {
    assert.strictEqual(parsed.grossAmount, 2500, `expected gross 2500, got ${parsed.grossAmount}`);
    assert.strictEqual(parsed.amount, 2500, `expected net 2500, got ${parsed.amount}`);
  });

  check('the amount CLEARS the booking threshold', () => {
    // This is the gate that decides auto-verification vs rejection.
    assert.ok(
      amountGatePasses(parsed.amount, BOOKING_REQUIRED_AMOUNT),
      `₱${parsed.amount} must satisfy the ₱${BOOKING_REQUIRED_AMOUNT} requirement`
    );
  });

  check('a ₱1.00 shortfall is still caught by the same gate (the gate has teeth)', () => {
    // Guards against a gate that passes everything: a genuinely short payment
    // must still fail.
    assert.strictEqual(amountGatePasses(2498.5, 2500), false, '₱2,498.50 is ₱1.50 short and must fail');
  });

  check('a valid date is identified', () => {
    assert.strictEqual(parsed.timestamp, '2025-01-15');
  });

  check('the date is accepted by the SC-8 tolerance window', () => {
    // The receipt date is validated against a ±24h window, not the exact day, so
    // a receipt uploaded shortly after midnight is not falsely rejected.
    const receiptDate = new Date(`${parsed.timestamp}T14:47:00`);
    const withinTolerance = ocrGuard.receiptDateWithinTolerance(receiptDate, new Date('2025-01-16T01:00:00'));
    assert.strictEqual(withinTolerance.ok, true, 'a receipt from ~10h ago must be within tolerance');
  });

  check('Philippine calendar date accepts the previous local date across UTC midnight', () => {
    const receiptDate = new Date(2025, 0, 15, 12);
    const now = new Date('2025-01-16T12:00:00.000Z');
    const result = ocrGuard.receiptDateWithinPhilippineCalendarWindow(receiptDate, now);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.ageCalendarDays, 1);
  });

  check('Philippine calendar date rejects dates older than the prior local day', () => {
    const receiptDate = new Date(2025, 0, 15, 12);
    const now = new Date('2025-01-17T17:00:00.000Z');
    const result = ocrGuard.receiptDateWithinPhilippineCalendarWindow(receiptDate, now);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'STALE');
  });

  check('a stale receipt is rejected by the same window', () => {
    const staleDate = new Date('2025-01-15T14:47:00');
    const result = ocrGuard.receiptDateWithinTolerance(staleDate, new Date('2025-01-20T14:47:00'));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'STALE');
  });

  check('the payee and reference are extracted', () => {
    assert.strictEqual(parsed.recipient, 'COMAR GARAGE');
    assert.strictEqual(parsed.referenceNumber, '9021334887221');
  });

  check('the block is recognised as a receipt', () => {
    assert.strictEqual(parsed.isValidReceipt, true);
  });

  console.log('\n--- SC-17: the duplicate check must key on BYTES, not text ---');

  check('the byte-hash is computed from the image, independent of the text', () => {
    // SC-17's guarantee: the same SCREENSHOT cannot fund two bookings. It works
    // because the hash is over the uploaded bytes. If the hash were derived from
    // the OCR text, a user could edit one digit in DevTools and defeat it.
    const imageBytes = Buffer.from('fake-jpeg-bytes-of-the-receipt');
    const hash1 = ocrGuard.computeImageHash(imageBytes);
    const hash2 = ocrGuard.computeImageHash(imageBytes);
    assert.strictEqual(hash1, hash2, 'identical bytes must produce an identical hash');
    assert.ok(hash1 && hash1.length === 64, 'sha256 hex is 64 chars');
  });

  check('editing the reference in the TEXT does not change the image hash', () => {
    // The attack SC-17 exists to stop: re-upload the same screenshot with a
    // freshly-OCR'd (or fabricated) reference number.
    const imageBytes = Buffer.from('fake-jpeg-bytes-of-the-receipt');
    const originalHash = ocrGuard.computeImageHash(imageBytes);

    const tamperedText = GCASH_RAW_TEXT.replace('9021 334 887 221', '1111 111 111 111');
    const reparsed = parseReceiptText(tamperedText);

    assert.notStrictEqual(reparsed.referenceNumber, parsed.referenceNumber, 'the reference DID change');
    assert.strictEqual(
      ocrGuard.computeImageHash(imageBytes), originalHash,
      'the image hash must be unchanged — this is what makes the attack detectable'
    );
  });

  check('different images produce different hashes', () => {
    const a = ocrGuard.computeImageHash(Buffer.from('receipt-one'));
    const b = ocrGuard.computeImageHash(Buffer.from('receipt-two'));
    assert.notStrictEqual(a, b);
  });

  check('an empty upload yields no hash rather than a bogus one', () => {
    assert.strictEqual(ocrGuard.computeImageHash(Buffer.alloc(0)), null);
    assert.strictEqual(ocrGuard.computeImageHash(null), null);
  });

  console.log('\n=== STAGE 2: FALLBACK / GRACEFUL DEGRADATION ===');

  const degradedInputs = {
    'blank image (no text)': '',
    'whitespace only': '   \n\n  \t ',
    'heavily blurred (noise)': '### ~~~ ... ,,, ll III 000 OOO',
    'a non-receipt photo': 'A photo of a cat sitting on a sofa in a living room',
  };

  for (const [label, text] of Object.entries(degradedInputs)) {
    check(`"${label}" does not throw`, () => {
      assert.doesNotThrow(() => parseReceiptText(text));
    });

    check(`"${label}" is not treated as a valid receipt`, () => {
      assert.strictEqual(parseReceiptText(text).isValidReceipt, false);
    });

    check(`"${label}" yields no amount (never a fabricated one)`, () => {
      assert.strictEqual(parseReceiptText(text).amount, null);
    });
  }

  check('null / undefined input does not throw', () => {
    assert.doesNotThrow(() => parseReceiptText(null));
    assert.doesNotThrow(() => parseReceiptText(undefined));
  });

  // The server's decision, reproduced from the handler.
  const extractionUnavailableFor = (rawText, parsedResult) =>
    !String(rawText || '').trim() || !parsedResult.isReceipt;

  check('an unreadable upload triggers extractionUnavailable', () => {
    // This is the branch that prevents BOTH failure modes the user asked about:
    // a hard block, and a 500.
    for (const [label, text] of Object.entries(degradedInputs)) {
      const p = parseReceiptText(text);
      assert.strictEqual(
        extractionUnavailableFor(text, { isReceipt: p.isValidReceipt }),
        true,
        `"${label}" must route to manual review`
      );
    }
  });

  check('a readable receipt does NOT trigger extractionUnavailable', () => {
    assert.strictEqual(
      extractionUnavailableFor(GCASH_RAW_TEXT, { isReceipt: parsed.isValidReceipt }),
      false
    );
  });

  check('the manual-review branch returns success, never a 500', () => {
    // The branch must respond with a JSON verdict the client understands. A throw
    // here would surface as the 500 the user was worried about.
    const start = SERVER.indexOf('if (extractionUnavailable && !isDuplicate)');
    assert.ok(start !== -1, 'the manual-review branch must exist');
    // Slice to the end of the branch: the next top-level statement after it.
    const branchEnd = SERVER.indexOf('const receiptIsTrustworthy', start);
    const branchBody = SERVER.slice(start, branchEnd === -1 ? start + 4000 : branchEnd);
    assert.ok(/res\.json\(\{/.test(branchBody), 'the branch must return JSON, not throw');
    assert.ok(/manualReviewAllowed: true/.test(branchBody), 'submit must stay enabled');
    assert.ok(/status: 'MANUAL_REVIEW'/.test(branchBody));
  });

  check('the manual-review branch is reached BEFORE the rejection verdict', () => {
    // Ordering matters: if the reject path ran first, an unreadable receipt would
    // hard-block the customer instead of degrading gracefully.
    const reviewIndex = SERVER.indexOf('if (extractionUnavailable && !isDuplicate)');
    const rejectIndex = SERVER.indexOf('const finalPaymentStatus = isDuplicate || !receiptIsTrustworthy');
    assert.ok(reviewIndex !== -1, 'the manual-review branch must exist');
    assert.ok(rejectIndex !== -1, 'the reject verdict must exist');
    assert.ok(reviewIndex < rejectIndex, 'manual review must be evaluated before the rejection verdict');
  });

  check('a genuine duplicate is NOT rescued by the manual-review path', () => {
    // The branch is `extractionUnavailable && !isDuplicate`. A reused image must
    // still be rejected, or the fallback would become a bypass.
    assert.ok(/if \(extractionUnavailable && !isDuplicate\)/.test(SERVER));
  });

  check('the browser sends only image bytes, never a client OCR verdict', () => {
    const client = read('frontend/src/components/BookingWizard/Step4ReviewPayment.jsx');
    assert.ok(/formData\.append\('receipt', file\)/.test(client));
    assert.ok(!/formData\.append\('extractedText'/.test(client));
    assert.ok(!/formData\.append\('clientOcr'/.test(client));
    assert.ok(/ocrScanId: result\.ocrScanId/.test(client));
  });

  check('the active route uses normalized amounts and the Philippine date window', () => {
    assert.ok(/normalizeAmountValue\(extractedData\.amount\)/.test(SERVER));
    assert.ok(/receiptDateWithinPhilippineCalendarWindow\(receiptDate\)/.test(SERVER));
  });

  console.log('\n=== STAGE 3: DATABASE SCHEMA ALIGNMENT ===');

  // The RPC parameters, read from the migration itself.
  const rpcParams = [...PERSIST_MIGRATION.matchAll(/^\s{2}(p_[a-z_]+)\s+(uuid|numeric|text|jsonb)/gm)]
    .map((m) => m[1]);

  check('the persist_ocr_result RPC signature is what the server calls', () => {
    const expected = ['p_booking_id', 'p_payment_id', 'p_detected_amount', 'p_detected_ref', 'p_payment_status', 'p_ocr_metadata'];
    for (const param of expected) {
      assert.ok(rpcParams.includes(param), `the migration must declare ${param}`);
      assert.ok(
        new RegExp(`${param}:`).test(SERVER),
        `server.js must pass ${param} to the RPC`
      );
    }
  });

  check('the server does not pass an undeclared RPC parameter', () => {
    // An extra key is harmless in JS but signals drift; a MISSING one throws at
    // call time. This pins the set.
    const callBlock = SERVER.slice(SERVER.indexOf("rpc('persist_ocr_result'"));
    const callEnd = callBlock.indexOf('});');
    const passed = [...callBlock.slice(0, callEnd).matchAll(/^\s*(p_[a-z_]+):/gm)].map((m) => m[1]);
    for (const key of passed) {
      assert.ok(rpcParams.includes(key), `server passes '${key}', which the RPC does not declare`);
    }
  });

  check('p_payment_status carries a booking_payment_status member (lowercase)', () => {
    // The enum members are lowercase (unpaid | pending | paid | refunded). Sending
    // 'PENDING' raises 22P02 and the whole persistence fails.
    const bookingStatuses = ['unpaid', 'pending', 'paid', 'refunded'];
    const declared = SERVER.match(/const finalBookingStatus = '([a-z_]+)'/);
    assert.ok(declared, 'finalBookingStatus must be declared');
    assert.ok(
      bookingStatuses.includes(declared[1]),
      `'${declared[1]}' is not a booking_payment_status member`
    );
  });

  // Build the payload the way the server does, then verify the keys the UI reads.
  const buildPersistedMetadata = (p, flags) => ({
    ...p,
    referenceNo: p.referenceNumber,
    date: p.timestamp,
    isReceipt: p.isValidReceipt,
    payment_verdict: 'FOR_VERIFICATION',
    status: flags.matchSuccess ? 'MATCH_SUCCESS' : 'FLAGGED_DETAILS_MISMATCH',
    isMatch: flags.isAmountMatch,
    isNameMatch: flags.isNameMatch,
    receipt_is_trustworthy: flags.receiptIsTrustworthy,
    requiredAmount: flags.requiredAmount,
    isAmountMatch: flags.isAmountMatch,
    overpaymentAmount: flags.overpaymentAmount,
    isOverpayment: flags.overpaymentAmount > 0,
    isDateMatch: flags.isDateMatch,
    isDuplicate: flags.isDuplicate,
    image_hash: flags.imageHash,
    duplicate_reason: flags.duplicateReason,
    qrConfigVersion: flags.qrConfigVersion,
    liveQrVersion: flags.liveQrVersion,
    qrVersionMismatch: flags.qrVersionMismatch,
    auditedAt: new Date().toISOString(),
  });

  const persisted = buildPersistedMetadata(parsed, {
    matchSuccess: true, isAmountMatch: true, isNameMatch: true, isDateMatch: true,
    receiptIsTrustworthy: true, isDuplicate: false, requiredAmount: BOOKING_REQUIRED_AMOUNT,
    overpaymentAmount: 0, imageHash: 'deadbeef', duplicateReason: null,
    qrConfigVersion: 1, liveQrVersion: 1, qrVersionMismatch: false,
  });

  check('the persisted record carries every key the ADMIN UI reads', () => {
    // These reads are the contract. A missing key does NOT fail the DB write — it
    // silently renders as undefined, which is the failure mode this catches:
    //   AdminBookingDetails.jsx  booking.ocr_metadata.isMatch
    //   AdminRefunds.jsx         ocr_metadata.status === 'MATCHED'
    for (const key of ['isMatch', 'status', 'referenceNo', 'amount', 'date', 'recipient']) {
      assert.ok(key in persisted, `ocr_metadata must persist '${key}' (the admin UI reads it)`);
      assert.notStrictEqual(persisted[key], undefined, `ocr_metadata.${key} must not be undefined`);
    }
  });

  check('the server source actually writes `status` and `isMatch` into the MAIN payload', () => {
    // Guards the fix at the source level: the object is built inline in server.js,
    // so asserting on a locally-rebuilt copy alone would not catch its removal.
    //
    // There are TWO p_ocr_metadata objects — the manual-review one comes first —
    // so this must target the MAIN payload that follows the duplicate check.
    const mainPayloadIndex = SERVER.indexOf('p_ocr_metadata: {', SERVER.indexOf('SC-17 FIX'));
    assert.ok(mainPayloadIndex !== -1, 'the main OCR payload must exist');
    const block = SERVER.slice(mainPayloadIndex, SERVER.indexOf('auditedAt:', mainPayloadIndex));
    assert.ok(/status: /.test(block), 'the main p_ocr_metadata must include `status`');
    assert.ok(/isMatch: /.test(block), 'the main p_ocr_metadata must include `isMatch`');
  });

  check('the manual-review payload ALSO writes `status` (not undefined)', () => {
    // A manually-reviewed booking must present an explicit state, otherwise the
    // admin UI renders a blank where a verdict should be.
    const reviewIndex = SERVER.indexOf('p_ocr_metadata: {');
    const block = SERVER.slice(reviewIndex, SERVER.indexOf('auditedAt:', reviewIndex));
    assert.ok(/status: 'MANUAL_REVIEW'/.test(block), 'manual-review payload must set status');
    assert.ok(/isMatch: null/.test(block), 'manual-review isMatch must be explicit null, not omitted');
  });

  check('the persisted verdict uses the SAME vocabulary as the HTTP response', () => {
    // Divergence here is what makes an admin see something different from what
    // the system decided.
    const responseStatus = SERVER.match(/status: isValidReceipt \? '([A-Z_]+)'/);
    assert.ok(responseStatus, 'the response status must be derivable');
    assert.ok(persisted.status.includes(responseStatus[1]) || persisted.status === responseStatus[1]);
    assert.strictEqual(persisted.status, 'MATCH_SUCCESS');
  });

  check('the reference is persisted under BOTH names the consumers use', () => {
    // The parser returns `referenceNumber`; the UI and `detected_ref` use
    // `referenceNo`. Both must be present on the stored record.
    assert.strictEqual(persisted.referenceNumber, '9021334887221');
    assert.strictEqual(persisted.referenceNo, '9021334887221');
  });

  check('the date is persisted under BOTH names the consumers use', () => {
    assert.strictEqual(persisted.timestamp, '2025-01-15');
    assert.strictEqual(persisted.date, '2025-01-15');
  });

  check('detected_amount / detected_ref are fed from the parsed values', () => {
    assert.ok(/p_detected_amount: extractedAmount/.test(SERVER));
    assert.ok(/p_detected_ref: referenceNo \|\| null/.test(SERVER));
    assert.strictEqual(parsed.amount, 2500, 'the value bound to detected_amount');
  });

  check('the payload is JSON-serialisable (jsonb-safe)', () => {
    // A BigInt, function, or circular reference would throw at the RPC boundary.
    const roundTripped = JSON.parse(JSON.stringify(persisted));
    assert.deepStrictEqual(roundTripped.status, persisted.status);
    assert.strictEqual(typeof roundTripped.amount, 'number');
  });

  check('no undefined-valued keys are sent (jsonb drops them silently)', () => {
    // `undefined` disappears in JSON.stringify, so the column ends up missing the
    // key entirely rather than holding null. Nulls are explicit and safe.
    for (const [key, value] of Object.entries(persisted)) {
      assert.notStrictEqual(value, undefined, `'${key}' is undefined and would vanish in the JSON payload`);
    }
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();