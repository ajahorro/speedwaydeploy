const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReceiptText, isValidReferenceNumber } = require('../backend/services/receiptTextParser');

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
  assert.equal(parsed.timestamp, null);
  assert.equal(parsed.isValidReceipt, true);
});

test('parses InstaPay amount and split reference number without treating amount as fee', () => {
  const raw = [
    'Paid PHP 10,500.00 POB IBFT BN-20260713-08060164',
    'Total Amount',
    'PHP 10,500.00',
    'Service Fee',
    'PHP 0.00',
    'Reference no.',
    'BN-20260713-08060164',
    'Invoice no.',
    '662965',
  ].join('\n');

  const parsed = parseReceiptText(raw);

  assert.equal(parsed.amount, 10500);
  assert.equal(parsed.grossAmount, 10500);
  assert.equal(parsed.transferFee, 0);
  assert.equal(parsed.referenceNumber, 'BN-20260713-08060164');
  assert.equal(isValidReferenceNumber(parsed.referenceNumber), true);
});

test('accepts internal reference separators but rejects unsupported punctuation and short values', () => {
  assert.equal(isValidReferenceNumber('BN-20260713-08060164'), true);
  assert.equal(isValidReferenceNumber('ABCD 123456'), true);
  assert.equal(isValidReferenceNumber('ABC/123456'), false);
  assert.equal(isValidReferenceNumber('ABC-12'), false);
});
