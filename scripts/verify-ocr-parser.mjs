// Receipt text parser: typical e-wallet and bank receipt texts must give the right net amount, fee and
// reference number. (The photo-to-text step is Tesseract; this guards the reading of its text.)
//   node scripts/verify-ocr-parser.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { parseReceiptText } = require('../backend/services/receiptTextParser.js');

const cases = [
  ['GCash, no fee', 'GCash\nExpress Send\nTotal Amount Sent PHP 1,200.00\nRef No. 7034 123 456789', { amount: 1200, fee: 0, ref: '7034123456789' }],
  ['GCash, fee on top (amount + fee = total sent)', 'GCash\nSend Money\nTo: COMAR GARAGE\nAmount 500.00\nTransfer Fee 5.00\nTotal Amount Sent PHP 505.00\nRef No. 1234 567 890123', { amount: 500, fee: 5, ref: '1234567890123' }],
  ['GCash, label and figure on separate lines', 'GCash\nTo: COMAR GARAGE\nAmount\n2,500.00\nTotal Amount Sent\n2,500.00\nRef No. 9876 543 210987', { amount: 2500, fee: 0, ref: '9876543210987' }],
  ['Maya, "Reference ID" label', 'maya\nPayment successful\nPaid to COMAR GARAGE\nPHP 750.00\nReference ID 0A1B2C3D4E5F', { amount: 750, fee: 0, ref: '0A1B2C3D4E5F' }],
  ['bank transfer', 'BDO Online Banking\nFund Transfer Successful\nTransfer to: COMAR GARAGE\nAmount: PHP 2,000.00\nReference No: 20261005123456', { amount: 2000, fee: 0, ref: '20261005123456' }],
  ['"Ref. No." with a dot', 'GCash\nSent to COMAR GARAGE\nAmount 300.00\nRef. No. 5012 345 678901', { amount: 300, fee: 0, ref: '5012345678901' }]
];

let failed = 0;
for (const [name, text, expected] of cases) {
  const result = parseReceiptText(text);
  try {
    assert.equal(result.amount, expected.amount, 'amount');
    assert.equal(result.transferFee, expected.fee, 'fee');
    assert.equal(result.referenceNumber, expected.ref, 'reference');
    assert.equal(result.isValidReceipt, true, 'recognised as a receipt');
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}: ${error.message} (got ${JSON.stringify({ amount: result.amount, fee: result.transferFee, ref: result.referenceNumber })})`);
  }
}
const junk = parseReceiptText('hello world, a photo of a cat');
if (junk.isValidReceipt !== false || junk.amount !== null) { failed += 1; console.error('FAIL  a non-receipt must not be accepted'); } else console.log('PASS  a non-receipt is rejected');
console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} receipt-reading checks passed.`);
process.exit(failed ? 1 : 0);
