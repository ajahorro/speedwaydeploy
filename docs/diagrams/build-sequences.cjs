// Sequence diagrams: booking with a digital payment, payment verification, cancellation and refund.
const { save } = require('./lib.cjs');
const { seq } = require('./seq.cjs');

const S1 = seq('Sequence Diagram: Customer Books an Appointment with a Digital Payment',
  ['Customer', 'Web app', 'Backend', 'Database', 'Email service'],
  [
    { f: 0, t: 1, label: 'Choose vehicles, services, date, and time' },
    { f: 1, t: 3, label: 'Read shop settings, services, promos, and blocked times' },
    { f: 3, t: 1, label: 'Current rules', ret: true },
    { f: 1, t: 2, label: 'Check that the time is free (advice only)' },
    { f: 2, t: 3, label: 'Read the existing bookings' },
    { f: 2, t: 1, label: 'The time is free', ret: true },
    { f: 0, t: 1, label: 'Upload the GCash or bank receipt' },
    { f: 1, t: 2, label: 'Send the receipt image' },
    { f: 2, t: 2, label: 'Read the receipt text (OCR); compare amount, shop account, and reference' },
    { f: 2, t: 1, label: 'Receipt accepted, or marked for the administrator to check by hand', ret: true },
    { f: 1, t: 3, label: 'Create the booking in one step' },
    { f: 3, t: 3, label: 'Re-check hours, closed days, blocked times, room, price, and promo; save the booking, vehicles, services, and the payment waiting for verification', max: 30 },
    { f: 3, t: 1, label: 'Booking created', ret: true },
    { f: 1, t: 4, label: 'Ask for the booking-created email' },
    { f: 4, t: 0, label: 'Email and in-app notice', ret: true }
  ],
  { colW: 235, selfMax: 42, key: 'Key: solid arrow = request; dashed arrow = response; a small loop = a step inside that part. The database repeats the checks, so the earlier ones only save time.' });

const S2 = seq('Sequence Diagram: Administrator Verifies a Payment',
  ['Administrator', 'Web app', 'Backend', 'Database', 'Email service', 'Customer'],
  [
    { f: 0, t: 1, label: 'Open the booking and its receipt' },
    { f: 1, t: 3, label: 'Load the payments and the balance' },
    { f: 3, t: 1, label: 'One ledger: paid, owed, refunded', ret: true },
    { f: 0, t: 1, label: 'Verify the payment (or reject it with a reason)' },
    { f: 1, t: 3, label: 'Save the verification' },
    { f: 3, t: 3, label: 'Keep the verified amount, who checked and when; write the audit entry. A rejection sets the payment to Rejected' },
    { f: 1, t: 2, label: 'Update the booking after the payment' },
    { f: 2, t: 3, label: 'Read the ledger and the technicians' },
    { f: 2, t: 2, label: 'Downpayment met and every vehicle has a technician: Confirmed. All vehicles done and fully paid: Completed' },
    { f: 2, t: 3, label: 'Save the new status; notify the assigned staff' },
    { f: 2, t: 4, label: 'Send the payment receipt, and the confirmation when it applies' },
    { f: 4, t: 5, label: 'Receipt email', ret: true }
  ],
  { colW: 205, selfMax: 34, key: 'Key: solid arrow = request; dashed arrow = response. The same steps run for cash recorded by the administrator.' });

const S3 = seq('Sequence Diagram: Cancellation and Refund',
  ['Customer', 'Administrator', 'Web app', 'Backend', 'Database', 'Email service'],
  [
    { f: 0, t: 2, label: 'Cancel the booking and give a reason' },
    { f: 2, t: 3, label: 'Cancel request with the sign-in token' },
    { f: 3, t: 3, label: 'Check that the user owns the booking' },
    { f: 3, t: 4, label: 'Cancel the booking' },
    { f: 4, t: 4, label: 'Check that no vehicle has started; mark Cancelled; release the slot and technicians; queue a refund for any payment made; write the audit entry' },
    { f: 4, t: 3, label: 'Result and the refund amount', ret: true },
    { f: 3, t: 5, label: 'Cancellation email with the refund status' },
    { f: 5, t: 0, label: 'Email to the customer', ret: true },
    { f: 1, t: 2, label: 'Open the Refund Hub and review the queued refund' },
    { f: 2, t: 4, label: 'Record the refund' },
    { f: 4, t: 4, label: 'Mark the payment Refunded; write the audit entry' },
    { f: 2, t: 5, label: 'Send the refund receipt' },
    { f: 5, t: 0, label: 'Refund receipt to the customer', ret: true }
  ],
  { colW: 205, selfMax: 34, key: 'Key: solid arrow = request; dashed arrow = response. Nothing is paid back automatically: the refund waits in the Refund Hub for the administrator.' });

(async () => { await save(__dirname, { 'sequence-booking-payment': S1, 'sequence-payment-verification': S2, 'sequence-cancel-refund': S3 }); })();
