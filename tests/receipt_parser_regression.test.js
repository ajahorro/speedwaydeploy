const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReceiptText } = require('../backend/services/receiptTextParser');

test('parses common GCash-style receipt text with Paid/Date/Ref labels', () => {
  const raw = [
    'Paid via GCash',
    'PHP 10,500.00',
    'Date: 11/07/2025',
    'Ref No: 87A2K9L1',
  ].join('\n');

  const parsed = parseReceiptText(raw);

  assert.equal(parsed.amount, 10500);
  assert.equal(parsed.referenceNumber, '87A2K9L1');
  assert.equal(parsed.timestamp, '2025-07-11');
  assert.equal(parsed.isValidReceipt, true);
});
