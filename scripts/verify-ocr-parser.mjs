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
  ['"Ref. No." with a dot', 'GCash\nSent to COMAR GARAGE\nAmount 300.00\nRef. No. 5012 345 678901', { amount: 300, fee: 0, ref: '5012345678901' }],
  // Real reads of two sample GCash receipts: the figure sat above its label, or no labels were read at all.
  ['GCash, figure ABOVE "Amount Paid" with a "03:45 PM" time below it (was read as 45 pesos)', 'Transaction Successful\nP2,500.00\nAmount Paid\nDate & Time Oct 26, 2023, 03:45 PM\nReference No 3927160889012\nMode of Payment GCash Wallet\nRecipient Details\nRecipient Name\nBunny Monera\nAccount Number\n0927 571 8000\nPurpose\nPersonal Transaction', { amount: 2500, fee: 0, ref: '3927160889012', recipient: 'Bunny Monera' }],
  ['GCash, labels not read (reference and recipient found by their shape)', '1:04 2 we @\n< Payment Successful\n{Ill oct26.2023 1430PM P231026A812345\n$2,500.00\nBunny Monera\n09275718000\nSend Money\nGCash **+* 8000\nSample payment for OCR testing', { amount: 2500, fee: 0, ref: 'P231026A812345', recipient: 'Bunny Monera' }],
  ['a time next to the amount label is never an amount', 'GCash\nAmount Sent\nOct 5, 2026, 11:45 AM\nPHP 1,750.00\nRef No. 4821 556 019283', { amount: 1750, fee: 0, ref: '4821556019283' }],
  ['a long reference number is never an amount', 'GCash\nPayment Successful\nPHP 900.00\nReference No. P231026AB12345', { amount: 900, fee: 0, ref: 'P231026AB12345' }],
  ['GCash, Amount 1,170 + Fee 15 = Total Amount 1,185 (was read as 1,155)', 'Payment Successful\nP1,170.00\nPaid via GCash\nBiller Online Booking\nRecipient Name Bunny Monera\nAccount Number 09275718000\nBank GoTyme Bank\nAmount Details\nAmount P1,170.00\nFee P15.00\nTotal Amount P1,185.00\nReference Number GC1234567890', { amount: 1170, fee: 15, ref: 'GC1234567890' }],
  ['amount + fee = a plain "Total" line', 'GCash\nAmount 800.00\nFee 10.00\nTotal 810.00\nRef No. 1234 567 890123', { amount: 800, fee: 10, ref: '1234567890123' }],
  ['the "Recipient Details" heading is not the recipient', 'GCash\nAmount 500.00\nRecipient Details\nRecipient Name\nCOMAR GARAGE\nRef No. 1111 222 333444', { amount: 500, fee: 0, ref: '1111222333444', recipient: 'COMAR GARAGE' }]
];

let failed = 0;
for (const [name, text, expected] of cases) {
  const result = parseReceiptText(text);
  try {
    assert.equal(result.amount, expected.amount, 'amount');
    assert.equal(result.transferFee, expected.fee, 'fee');
    assert.equal(result.referenceNumber, expected.ref, 'reference');
    assert.equal(result.isValidReceipt, true, 'recognised as a receipt');
    if (expected.recipient !== undefined) assert.equal(result.recipient, expected.recipient, 'recipient');
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
