import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQrSubmission } from './qrConfigUtils.js';

test('buildQrSubmission keeps the QR photo URL in the payload', () => {
  const payload = buildQrSubmission({
    qr_account_name: 'Speedway Studio',
    qr_account_number: '09123456789',
    fallback_receiver_name: 'Fallback',
    fallback_receiver_number: '09987654321',
    payment_qr_url: 'https://cdn.example.com/qr.png',
  });

  assert.equal(payload.payment_qr_url, 'https://cdn.example.com/qr.png');
  assert.equal(payload.qr_account_name, 'Speedway Studio');
});
