const assert = require('node:assert/strict');

(async () => {
  const { derivePaymentStatusBadge, calculatePaymentSummary } = await import('../frontend/src/utils/paymentUtils.js');

  // 1. Total Paid = ₱0 (No payments in ledger): MUST strictly read "Unpaid", NEVER "Fully Paid"
  const unpaidBooking = {
    id: 'test-unpaid-1',
    status: 'scheduled',
    total_amount: 2500,
    payments: []
  };
  const unpaidBadge = derivePaymentStatusBadge(unpaidBooking);
  assert.equal(unpaidBadge.statusKey, 'UNPAID');
  assert.match(unpaidBadge.text, /Unpaid/i);
  assert.match(unpaidBadge.text, /2,500/);
  assert.notEqual(unpaidBadge.text, 'Fully Paid');

  // 2. Cancelled booking with ₱0 recorded payments (The screenshot defect):
  // Even if internal balance is 0 for voided invoicing, the headline badge must NEVER read "Fully Paid"
  const cancelledUnpaidBooking = {
    id: 'test-cancelled-unpaid',
    status: 'cancelled',
    total_amount: 2500,
    payments: []
  };
  const cancelledUnpaidBadge = derivePaymentStatusBadge(cancelledUnpaidBooking);
  assert.equal(cancelledUnpaidBadge.statusKey, 'UNPAID');
  assert.match(cancelledUnpaidBadge.text, /Unpaid/i);
  assert.notEqual(cancelledUnpaidBadge.text, 'Fully Paid');

  // 3. 0 < Total Paid < Total Booking Value: MUST read "Partially Paid" with remaining balance
  const partialBooking = {
    id: 'test-partial-1',
    status: 'scheduled',
    total_amount: 2500,
    payments: [{ amount: 1000, status: 'PAID' }]
  };
  const partialBadge = derivePaymentStatusBadge(partialBooking);
  assert.equal(partialBadge.statusKey, 'PARTIALLY_PAID');
  assert.match(partialBadge.text, /Partially Paid/i);
  assert.match(partialBadge.text, /1,500/);
  assert.equal(partialBadge.balance, 1500);

  // 4. Total Paid >= Total Booking Value: Correctly reads "Fully Paid"
  const fullyPaidBooking = {
    id: 'test-paid-1',
    status: 'scheduled',
    total_amount: 2500,
    payments: [{ amount: 2500, status: 'PAID' }]
  };
  const fullyPaidBadge = derivePaymentStatusBadge(fullyPaidBooking);
  assert.equal(fullyPaidBadge.statusKey, 'FULLY_PAID');
  assert.equal(fullyPaidBadge.text, 'Fully Paid');

  // 5. Special Case (Fleet Accounts): Bypasses upfront cash -> "Billed to Corporate Account"
  const fleetInvoiceBooking = {
    id: 'test-fleet-1',
    status: 'scheduled',
    total_amount: 2500,
    billing_type: 'FLEET',
    payments: []
  };
  const fleetBadge = derivePaymentStatusBadge(fleetInvoiceBooking);
  assert.equal(fleetBadge.statusKey, 'FLEET_BILLING');
  assert.equal(fleetBadge.text, 'Billed to Corporate Account');
  assert.equal(fleetBadge.subtext, 'Account Invoice Pending');

  const fleetGroupBooking = {
    id: 'test-fleet-2',
    status: 'scheduled',
    total_amount: 2500,
    fleet_group_id: 'fleet-group-123',
    payments: []
  };
  const fleetGroupBadge = derivePaymentStatusBadge(fleetGroupBooking);
  assert.equal(fleetGroupBadge.statusKey, 'FLEET_BILLING');
  assert.equal(fleetGroupBadge.text, 'Billed to Corporate Account');

  // 6. Refunded booking: reads "Refunded"
  const refundedBooking = {
    id: 'test-refund-1',
    status: 'cancelled',
    total_amount: 2500,
    refund_status: 'PROCESSED',
    payments: [
      { amount: 2500, status: 'REFUNDED' },
      { amount: -2500, method: 'SYSTEM_REFUND', status: 'REFUNDED' }
    ]
  };
  const refundedBadge = derivePaymentStatusBadge(refundedBooking);
  assert.equal(refundedBadge.statusKey, 'REFUNDED');
  assert.equal(refundedBadge.text, 'Refunded');

  console.log('PASS 1. Total Paid = ₱0 derives Unpaid (with balance shown), never Fully Paid');
  console.log('PASS 2. Cancelled unpaid booking derives Unpaid, never Fully Paid');
  console.log('PASS 3. 0 < Total Paid < Total Value derives Partially Paid with balance');
  console.log('PASS 4. Total Paid >= Total Value derives Fully Paid');
  console.log('PASS 5. Fleet account without upfront cash derives Billed to Corporate Account');
  console.log('PASS 6. Fully refunded booking derives Refunded');
})();
