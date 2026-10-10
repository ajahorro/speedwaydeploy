import test from 'node:test';
import assert from 'node:assert/strict';
import { getOverpaymentRefundRemaining, getRefundRequestLimit, isPendingRefundRequest } from './refundRequestUtils.js';

const creditRefund = (amount, extra = {}) => ({ amount, method: 'SYSTEM_REFUND', notes: 'OVERPAYMENT_CREDIT_REFUND:abc', ...extra });

test('overpayment refund remaining is the queued credit minus what was already refunded', () => {
  const creditEntries = [{ amount: -200 }, { amount: -50 }];
  assert.equal(getOverpaymentRefundRemaining({ creditEntries, payments: [] }), 250);
  assert.equal(getOverpaymentRefundRemaining({ creditEntries, payments: [creditRefund(-75)] }), 175);
  assert.equal(getOverpaymentRefundRemaining({ creditEntries, payments: [creditRefund(-75), creditRefund(-25)] }), 150);
});

test('overpayment refund remaining never goes below zero', () => {
  assert.equal(getOverpaymentRefundRemaining({ creditEntries: [{ amount: -100 }], payments: [creditRefund(-300)] }), 0);
  assert.equal(getOverpaymentRefundRemaining({ creditEntries: [], payments: [creditRefund(-50)] }), 0);
  assert.equal(getOverpaymentRefundRemaining(), 0);
});

test('only overpayment-credit refund rows count as already refunded', () => {
  const creditEntries = [{ amount: -100 }];
  const payments = [
    { amount: 500, method: 'GCASH', notes: '' },                                     // a payment, not a refund
    { amount: -40, method: 'SYSTEM_REFUND', notes: 'CANCELLATION_REFUND:x' },        // a different kind of refund
    { amount: -40, method: 'cash', notes: 'OVERPAYMENT_CREDIT_REFUND:x' },           // wrong method
    creditRefund(-30, { method: ' system_refund ' })                                  // method is matched trimmed, any case
  ];
  assert.equal(getOverpaymentRefundRemaining({ creditEntries, payments }), 70);
});

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
