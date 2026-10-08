import test from 'node:test';
import assert from 'node:assert/strict';
import { getRefundRequestLimit, isPendingRefundRequest } from './refundRequestUtils.js';

test('uses remaining queued overpayment credit before a booking ledger balance', () => {
  assert.equal(getRefundRequestLimit({ totalPaid: 500, overpaymentRefundRemaining: 125 }), 125);
  assert.equal(getRefundRequestLimit({ totalPaid: 500, overpaymentRefundRemaining: 0 }), 500);
});

test('counts only pending refund states with a positive refundable amount', () => {
  assert.equal(isPendingRefundRequest({ refundStatus: 'QUEUED', refundLimit: 1 }), true);
  assert.equal(isPendingRefundRequest({ refundStatus: 'PROCESSING', refundLimit: 1 }), true);
  assert.equal(isPendingRefundRequest({ refundStatus: 'EMAIL_PENDING', refundLimit: 1 }), true);
  assert.equal(isPendingRefundRequest({ refundStatus: 'PROCESSED', refundLimit: 1 }), false);
  assert.equal(isPendingRefundRequest({ refundStatus: 'QUEUED', refundLimit: 0 }), false);
  assert.equal(isPendingRefundRequest({ refundLimit: 1 }), true);
});
