const assert = require('node:assert/strict');

(async () => {
  const { calculatePaymentSummary } = await import('../frontend/src/utils/paymentUtils.js');

  const cancelledUnpaid = calculatePaymentSummary({
    status: 'cancelled',
    total_amount: 2500,
    payments: []
  });
  assert.equal(cancelledUnpaid.effectiveTotalAmount, 0);
  assert.equal(cancelledUnpaid.balance, 0);
  assert.equal(cancelledUnpaid.netBalance, 0);
  assert.equal(cancelledUnpaid.isCancelledNoFee, true);

  const scheduledUnpaid = calculatePaymentSummary({
    status: 'scheduled',
    total_amount: 2500,
    payments: []
  });
  assert.equal(scheduledUnpaid.effectiveTotalAmount, 2500);
  assert.equal(scheduledUnpaid.balance, 2500);
  assert.equal(scheduledUnpaid.isCancelledNoFee, false);

  const cancelledPending = calculatePaymentSummary({
    status: 'CANCELLED',
    total_amount: 2500,
    payments: [{ amount: 1250, status: 'FOR_VERIFICATION' }]
  });
  assert.equal(cancelledPending.effectiveTotalAmount, 2500);
  assert.equal(cancelledPending.balance, 2500);
  assert.equal(cancelledPending.isCancelledNoFee, false);

  console.log('PASS cancelled unpaid financial invariant');
  console.log('PASS active unpaid bookings retain their balance');
  console.log('PASS cancelled pending-payment bookings remain for reconciliation');
})();
