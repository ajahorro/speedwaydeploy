const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { calculateAdditionalDownpayment } = await import('../frontend/src/utils/paymentUtils.js');

  assert.equal(calculateAdditionalDownpayment(2800, 1500, 500), 0);
  assert.equal(calculateAdditionalDownpayment(2800, 1150, 500), 250);
  assert.equal(calculateAdditionalDownpayment(2800, 500, 500), 500);
  assert.equal(calculateAdditionalDownpayment(2800, 2800, 1200), 0);

  const adminBooking = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Admin/AdminBookingDetails.jsx'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const refunds = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Admin/AdminRefunds.jsx'), 'utf8');
  assert.doesNotMatch(adminBooking, /applyServiceDownpayment|apply_service_downpayment/);
  assert.match(server, /mutate_booking_locked/);
  assert.doesNotMatch(server, /legacy locked fallback/);
  assert.match(refunds, /customer_credit_ledger/);
  assert.match(refunds, /process_overpayment_credit_refund/);

  console.log('PASS  added-service downpayment uses verified booking payments and never exceeds the new service price');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});