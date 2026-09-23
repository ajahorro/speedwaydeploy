import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQrSubmission, sanitizeQrAccountName, validateQrRecipients } from './qrConfigUtils.js';

test('buildQrSubmission keeps the QR photo URL in the payload', () => {
  const payload = buildQrSubmission({
    qr_account_name: 'Speedway Studio',
    qr_account_number: '09123456789',
    payment_qr_url: 'https://cdn.example.com/qr.png',
  });

  assert.equal(payload.payment_qr_url, 'https://cdn.example.com/qr.png');
  assert.equal(payload.qr_account_name, 'Speedway Studio');
});

test('sanitize keeps spaces in the account name while rejecting all-space values', () => {
  assert.equal(sanitizeQrAccountName('Speedway Studio '), 'Speedway Studio ');
  assert.equal(validateQrRecipients({ qr_account_name: ' ', qr_account_number: '09123456789', payment_qr_url: 'https://cdn.example.com/qr.png' }).ok, false);
  assert.equal(validateQrRecipients({ qr_account_name: 'Speedway Studio', qr_account_number: '09123456789', payment_qr_url: 'https://cdn.example.com/qr.png' }).ok, true);
});

test('buildQrSubmission includes compatibility fallback keys for the legacy OTP RPC contract', () => {
  const payload = buildQrSubmission({
    qr_account_name: 'Speedway Studio',
    qr_account_number: '09123456789',
    payment_qr_url: 'https://cdn.example.com/qr.png',
  });

  assert.equal(payload.fallback_receiver_name, '');
  assert.equal(payload.fallback_receiver_number, '');
});

test('validateQrRecipients rejects numbers in the account name and letters in the account number', () => {
  const invalidByName = validateQrRecipients({
    qr_account_name: 'Speedway 123',
    qr_account_number: '09123456789',
    payment_qr_url: 'https://cdn.example.com/qr.png',
  });

  const invalidByNumber = validateQrRecipients({
    qr_account_name: 'Speedway Studio',
    qr_account_number: '0912ABCD',
    payment_qr_url: 'https://cdn.example.com/qr.png',
  });

  assert.equal(invalidByName.ok, false);
  assert.equal(invalidByNumber.ok, false);
});
