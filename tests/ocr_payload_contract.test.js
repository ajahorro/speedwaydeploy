/**
 * tests/ocr_payload_contract.test.js
 * ============================================================================
 * Pins the WIRE CONTRACT between the browser and /api/ocr/verify-receipt.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Receipt extraction moved client-side (Tesseract.js) and the two halves are now
 * written in different languages on either side of an HTTP boundary. A rename on
 * one side — `extractedText` -> `rawText`, `clientOcr` -> `ocr`, dropping the
 * `receipt` file field — would not fail a type check or a unit test. It would
 * fail in PRODUCTION as "receipt could not be read", with the server silently
 * seeing an empty string and routing every payment to manual review.
 *
 * So the field names are asserted against BOTH sides:
 *   • the frontend's FormData keys (parsed from Step4ReviewPayment.jsx)
 *   • the backend's req.body / req.file reads (parsed from server.js)
 *
 * This is a source-level contract test on purpose. Importing the React component
 * would drag in the whole UI tree, and the thing being verified is the literal
 * string a developer types — which is exactly what a rename changes.
 *
 * Run: node tests/ocr_payload_contract.test.js
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

const STEP4 = read('frontend/src/components/BookingWizard/Step4ReviewPayment.jsx');
const SERVER = read('backend/server.js');
const CLIENT_OCR = read('frontend/src/utils/receiptOcr.js');
const SERVER_PARSER = read('backend/services/receiptTextParser.js');

// ── The field names, extracted from the source ───────────────────────────────
const sentFields = [...STEP4.matchAll(/formData\.append\(\s*'([^']+)'/g)].map((m) => m[1]);

console.log('=== the fields the frontend actually appends ===');
console.log('    ' + sentFields.join(', '));

const EXPECTED_SENT = ['receipt', 'bookingId', 'requiredAmount', 'expectedRecipientName', 'extractedText', 'clientOcr', 'expectedQrVersion'];

console.log('\n=== the payload contract ===');

check('the frontend sends exactly the expected field set', () => {
  for (const field of EXPECTED_SENT) {
    assert.ok(sentFields.includes(field), `the frontend must append '${field}' — the server reads it`);
  }
});

check('the RAW IMAGE field is named `receipt` (SC-17 depends on it)', () => {
  // Without this field there are no bytes to hash, and the duplicate-image gate
  // silently stops working.
  assert.ok(sentFields.includes('receipt'), 'the raw image must still be uploaded');
  assert.ok(/upload\.single\('receipt'\)/.test(SERVER), 'the server must read the image from the same field name');
});

check('the server reads `extractedText` (not rawText / ocrText)', () => {
  assert.ok(/req\.body\.extractedText/.test(SERVER), 'server must read req.body.extractedText');
  assert.ok(!/req\.body\.rawText/.test(SERVER), 'server must not expect a differently-named field');
});

check('the server reads `clientOcr`', () => {
  assert.ok(/req\.body\.clientOcr/.test(SERVER), 'server must read req.body.clientOcr');
});

check('the server reads `requiredAmount` and `expectedRecipientName`', () => {
  assert.ok(/req\.body\.requiredAmount/.test(SERVER));
  assert.ok(/req\.body\.expectedRecipientName/.test(SERVER));
});

check('the server reads `expectedQrVersion` (Scenario 8)', () => {
  assert.ok(/req\.body\.expectedQrVersion/.test(SERVER));
});

check('the clientOcr JSON carries the keys the server logs', () => {
  // The clientOcr blob is parsed for divergence logging only, but the keys are
  // part of the contract and a rename would make every comparison read undefined.
  for (const key of ['amount', 'grossAmount', 'transferFee', 'referenceNumber', 'timestamp', 'recipient', 'isValidReceipt']) {
    assert.ok(
      new RegExp(`\\b${key}\\s*:`).test(STEP4),
      `clientOcr must include '${key}'`
    );
  }
});

console.log('\n=== both parsers expose the same surface ===');

check('client and server parsers export the same function names', () => {
  const exportsOf = (src) => [...src.matchAll(/^\s{2}([a-zA-Z]+),?\s*$/gm)].map((m) => m[1]);
  const clientExports = exportsOf(CLIENT_OCR.slice(CLIENT_OCR.lastIndexOf('export default')));
  const serverExports = exportsOf(SERVER_PARSER.slice(SERVER_PARSER.lastIndexOf('module.exports')));

  for (const fn of ['parseReceiptText', 'parseAmountToken', 'extractAmounts', 'extractReferenceNumber', 'extractDate', 'extractRecipient', 'looksLikeReceipt']) {
    assert.ok(clientExports.includes(fn), `frontend receiptOcr.js must export ${fn}`);
    assert.ok(serverExports.includes(fn), `backend receiptTextParser.js must export ${fn}`);
  }
});

check('the parsed shape carries every field the clientOcr blob sends', () => {
  const { parseReceiptText } = require('../backend/services/receiptTextParser');
  const parsed = parseReceiptText('GCash\nSent to COMAR GARAGE\nTotal Amount Sent\nP2,500.00\nRef 1234567890\nJan 15, 2025');
  for (const key of ['amount', 'grossAmount', 'transferFee', 'referenceNumber', 'timestamp', 'recipient', 'isValidReceipt']) {
    assert.ok(key in parsed, `parseReceiptText must return '${key}'`);
  }
});

console.log('\n=== no orphaned Gemini references ===');

// A leftover import would crash at boot; a leftover STRING would ship to users.
check('server.js does not import the removed Gemini service', () => {
  assert.ok(!/require\(\s*'\.\/services\/ocrService'\s*\)/.test(SERVER), 'ocrService.js was deleted');
  assert.ok(!/processReceiptOCR/.test(SERVER), 'processReceiptOCR no longer exists');
  assert.ok(!/GoogleGenerativeAI/.test(SERVER));
});

check('no live code reads GEMINI_API_KEY', () => {
  // Comments explaining the migration are fine; executable reads are not.
  const executable = SERVER
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.ok(!/process\.env\.GEMINI_API_KEY/.test(executable), 'the Gemini key must not gate any feature');
});

check('the frontend has no Gemini references in executable code', () => {
  // Comments that explain WHY the migration happened are legitimate and must be
  // allowed — only executable references would be an orphaned dependency. Block
  // comments are stripped along with line comments before matching.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');

  assert.ok(!/gemini/i.test(stripComments(STEP4)), 'no executable Gemini reference in Step4ReviewPayment');
  assert.ok(!/gemini/i.test(stripComments(CLIENT_OCR)), 'no executable Gemini reference in receiptOcr.js');
});

check('the deleted ocrService.js is gone from disk', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'backend/services/ocrService.js')));
});

check('package.json files carry no Google AI dependency', () => {
  for (const pkg of ['package.json', 'backend/package.json', 'frontend/package.json']) {
    const src = read(pkg);
    assert.ok(!/generative-ai|@google\/genai/.test(src), `${pkg} still depends on a Google AI package`);
  }
});

check('frontend package.json declares tesseract.js', () => {
  assert.ok(/tesseract\.js/.test(read('frontend/package.json')));
});

console.log('\n=== upload limits ===');

check('multer enforces a file-size cap', () => {
  assert.ok(/limits:\s*\{[^}]*fileSize/.test(SERVER), 'an uncapped memory upload is a DoS vector');
});

check('an oversized upload returns 413, not 500', () => {
  assert.ok(/LIMIT_FILE_SIZE/.test(SERVER), 'multer error codes must be handled explicitly');
  assert.ok(/status\(413\)/.test(SERVER));
});

check('the client surfaces the 413 to the user', () => {
  assert.ok(/response\.status === 413/.test(STEP4), 'the client must handle 413 distinctly');
});

console.log('\n=== the OCR init cannot hang forever ===');

check('the Tesseract worker call is bounded by a timeout', () => {
  assert.ok(/OCR_INIT_TIMEOUT_MS/.test(CLIENT_OCR), 'a blocked worker download must not spin forever');
  assert.ok(/withTimeout\(/.test(CLIENT_OCR));
});

check('the worker is terminated even when init fails', () => {
  // `worker` is declared outside the try so the finally can see it, and the
  // terminate call is itself guarded against rejection.
  assert.ok(/let worker = null;/.test(CLIENT_OCR), 'worker must be declared before the try block');
  assert.ok(/catch \(terminateErr\)/.test(CLIENT_OCR), 'terminate() must not throw unhandled');
});

check('a failed extraction falls back to manual review rather than blocking', () => {
  assert.ok(/isValidReceipt: false, rawText: ''/.test(STEP4), 'the client must send an empty hint on failure');
  assert.ok(/extractionUnavailable/.test(SERVER), 'the server must route an empty hint to manual review');
});

console.log('\n=== race-condition guards ===');

check('the upload handler is guarded against overlapping scans', () => {
  assert.ok(/scanIdRef/.test(STEP4), 'a stale scan must not overwrite a newer one');
  assert.ok(/isStale\(\)/.test(STEP4));
});

check('isStale is checked before every UI write in the handler', () => {
  // Each of these writes would otherwise be clobbered by a slower earlier scan.
  const guardCount = (STEP4.match(/if \(isStale\(\)\) return;/g) || []).length;
  assert.ok(guardCount >= 4, `expected guards before each UI write, found ${guardCount}`);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);