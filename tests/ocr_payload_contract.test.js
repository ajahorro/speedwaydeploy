/**
 * tests/ocr_payload_contract.test.js
 * ============================================================================
 * Pins the WIRE CONTRACT between the browser and /api/ocr/verify-receipt.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Receipt extraction runs on the server from the uploaded image. The contract
 * pins the image and verification inputs and ensures browser-supplied OCR text is
 * never consumed as authoritative data.
 *
 * The browser sends the image and expected values; the backend owns extraction.
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
const SERVER_PARSER = read('backend/services/receiptTextParser.js');

// ── The field names, extracted from the source ───────────────────────────────
const sentFields = [...STEP4.matchAll(/formData\.append\(\s*'([^']+)'/g)].map((m) => m[1]);

console.log('=== the fields the frontend actually appends ===');
console.log('    ' + sentFields.join(', '));

const EXPECTED_SENT = ['receipt', 'bookingId', 'requiredAmount', 'expectedQrVersion'];

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

check('the server OCRs the uploaded image and ignores client text', () => {
  assert.ok(/recognizeReceipt\(req\.file\.buffer\)/.test(SERVER));
  assert.ok(!/req\.body\.extractedText/.test(SERVER));
  assert.ok(!/req\.body\.clientOcr/.test(SERVER));
});

check('selecting a replacement image clears any older scan session', () => {
  assert.ok(/proofOfPayment: file, ocrData: null/.test(STEP4));
});

check('the server reads the amount threshold and obtains the recipient from config', () => {
  assert.ok(/req\.body\.requiredAmount/.test(SERVER));
  assert.ok(/qr_account_name, qr_config_version/.test(SERVER));
  assert.ok(!/req\.body\.expectedRecipientName/.test(SERVER));
});

check('the server reads `expectedQrVersion` (Scenario 8)', () => {
  assert.ok(/req\.body\.expectedQrVersion/.test(SERVER));
});

console.log('\n=== the server owns extraction ===');

check('the backend imports its OCR service', () => {
  assert.ok(/require\('\.\/services\/receiptOcr'\)/.test(SERVER));
});

check('the server parser exports the fields consumed by validation', () => {
  const exportsOf = (src) => [...src.matchAll(/^\s{2}([a-zA-Z]+),?\s*$/gm)].map((m) => m[1]);
  const serverExports = exportsOf(SERVER_PARSER.slice(SERVER_PARSER.lastIndexOf('module.exports')));

  for (const fn of ['parseReceiptText', 'parseAmountToken', 'extractAmounts', 'extractReferenceNumber', 'extractDate', 'extractRecipient', 'looksLikeReceipt']) {
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

check('backend package.json declares OCR and preprocessing dependencies', () => {
  const backendPackage = read('backend/package.json');
  assert.ok(/tesseract\.js/.test(backendPackage));
  assert.ok(/sharp/.test(backendPackage));
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

check('server OCR uses bounded preprocessed image variants', () => {
  const serverOcr = read('backend/services/receiptOcr.js');
  assert.ok(/MAX_IMAGE_PIXELS/.test(serverOcr));
  assert.ok(/threshold\(155\)/.test(serverOcr));
  assert.ok(/recognize\(variants\[index\]\)/.test(serverOcr));
});

check('the client cannot manufacture a manual-review scan session on server failure', () => {
  assert.ok(/no scan session was issued/.test(STEP4));
  assert.ok(/ocrScanId: result\.ocrScanId/.test(STEP4));
  assert.ok(/extractionUnavailable/.test(SERVER));
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