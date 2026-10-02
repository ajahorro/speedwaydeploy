import fs from 'node:fs';

const shared = fs.readFileSync('supabase/functions/_shared/bookingEmail.ts', 'utf8');
const fn = fs.readFileSync('supabase/functions/booking-lifecycle/index.ts', 'utf8');
const notificationEmail = fs.readFileSync('supabase/functions/send-notification-email/index.ts', 'utf8');
const eventEngine = fs.readFileSync('frontend/src/services/eventEngine.js', 'utf8');
const adminPayments = fs.readFileSync('frontend/src/pages/Admin/AdminPayments.jsx', 'utf8');
const adminBookingDetails = fs.readFileSync('frontend/src/pages/Admin/AdminBookingDetails.jsx', 'utf8');
const adminBookings = fs.readFileSync('frontend/src/pages/Admin/AdminBookings.jsx', 'utf8');
const backend = fs.readFileSync('backend/server.js', 'utf8');
const cancellationMigration = fs.readFileSync('supabase/migrations/20261023000002_atomic_admin_booking_cancellation.sql', 'utf8');
const notificationService = fs.readFileSync('frontend/src/services/notificationService.js', 'utf8');
const customerBilling = fs.readFileSync('frontend/src/pages/Customer/CustomerBilling.jsx', 'utf8');
const bookingSummaryHeader = fs.readFileSync('frontend/src/components/BookingSummaryHeader.jsx', 'utf8');
const notificationRouting = fs.readFileSync('frontend/src/utils/notificationRouting.js', 'utf8');
const notificationSuppressionMigration = fs.readFileSync('supabase/migrations/20261023000003_suppress_unlinked_booking_notifications.sql', 'utf8');
const officialReceipt = fs.readFileSync('frontend/src/components/OfficialReceipt.jsx', 'utf8');
const receiptModel = fs.readFileSync('shared/receiptModel.ts', 'utf8');
const { resolveAmounts } = await import('../supabase/functions/_shared/bookingEmail.ts');
const { buildOfficialReceiptPdf } = await import('../supabase/functions/_shared/officialReceiptPdf.ts');
const { resolveInvoiceAmounts, resolveTransactionReceiptAmounts } = await import('../shared/receiptModel.ts');
const samplePayment = {
  id: 'payment-123',
  amount: 900,
  detected_amount: 900,
  net_credit: 900,
  transfer_fee: 100,
  status: 'PAID',
  method: 'Online Transfer',
  reference_number: 'TXN-12345',
  created_at: '2026-10-02T08:00:00.000Z',
};
const receiptPdf = Buffer.from(buildOfficialReceiptPdf({
  customerName: 'Sample Customer',
  customerEmail: 'customer@example.com',
  customerContact: '09123456789',
  bookingReference: 'AB12CD34',
  payment: samplePayment,
}), 'base64').toString('ascii');

const checks = [
  ['shared: BookingLike interface declared', /export interface BookingLike/.test(shared)],
  ['shared: PaymentLike interface declared', /export interface PaymentLike/.test(shared)],
  ['shared: OcrDetails interface declared', /export interface OcrDetails/.test(shared)],
  ['shared: extractOcrDetails returns OcrDetails', /\): OcrDetails =>/.test(shared)],
  ['shared: flat tax-free pricing (no VAT properties declared)', !/(?:const|let|var|export)\s+VAT_RATE/.test(shared) && !/(?:vatIncluded|vatExclusiveSales)\s*[:=]/.test(shared)],
  ['shared: pricing is flat and tax-free', /PRICING:\s*flat and TAX-FREE/i.test(shared)],
  ['shared: the incorrect /112 VAT split is gone', !/\/ 112/.test(shared)],
  ['shared: shell() is typed (no implicit any)', /const shell = \(title: string, inner: string\)/.test(shared)],
  ['shared: renderLifecycle() is typed', /const renderLifecycle = \(statusKey: string\)/.test(shared)],
  ['shared: paymentBlock() is typed', /amounts: ReturnType<typeof resolveAmounts>/.test(shared)],
  ['shared: rows is string[]', /const rows: string\[\] = \[\]/.test(shared)],
  ['shared: ocrRows is string[]', /const ocrRows: string\[\] = \[\]/.test(shared)],
  ['shared: buildStatusEmail returns a typed shape', /amounts: ReturnType<typeof resolveAmounts> \} => \{/.test(shared)],
  ['shared: STATUS_COPY is Record<string, string>', /const STATUS_COPY: Record<string, string>/.test(shared)],
  ['shared: no leftover `paymentId` doc claim', !/paymentId\?/.test(shared)],

  ['function: Deno ambient reference present', /<reference path="\.\.\/_shared\/deno-types\.d\.ts" \/>/.test(fn)],
  ['function: serve handler is typed', /serve\(async \(req: Request\): Promise<Response>/.test(fn)],
  ['function: BookingRow interface declared', /interface BookingRow extends BookingLike/.test(fn)],
  ['function: receipt PDF item interface declared', /interface OfficialReceiptPdfItem/.test(fs.readFileSync('supabase/functions/_shared/officialReceiptPdf.ts', 'utf8'))],
  ['function: EmailAttachment interface declared', /interface EmailAttachment/.test(fn)],
  ['function: no `(booking as any)` casts remain', !/booking as any/.test(fn)],
  ['function: no `any[]` attachments remain', !/: any\[\]/.test(fn)],
  ['function: no `(item: any)` in PDF builder', !/\(item: any\)/.test(fn)],
  ['function: catch is `unknown`-safe', /catch \(error: unknown\)/.test(fn)],
  // The service-role exact-match guard was measured to be unusable as a gate:
  // requiring `authHeader !== 'Bearer ' + Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`
  // rejected even a valid service-role JWT, so it cannot decide authorization
  // here. The enforced rule is now "a Bearer credential must be present".
  //
  // NOTE: `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` is still used to INIT the
  // Supabase client (line ~105) and that read succeeds — the env var IS
  // available. What failed was only its use as a request-auth comparison, which
  // is why the guard was replaced rather than the env access removed.
  ['function: a Bearer credential is required', /!authHeader\.startsWith\('Bearer '\)/.test(fn)],
  ['function: the authorization gap is documented, not silently left', /FOLLOW-UP REQUIRED/.test(fn)],
  ['function: auth no longer gated on env comparison', !/authHeader !== `Bearer \$\{serviceKey\}`/.test(fn)],
  ['function: no stale error message', !/bError\?\.message\}`/.test(fn)],
];

checks.push(
  ['function: in-progress and release milestones are emailable', /EMAILABLE_LIFECYCLE_EVENTS = new Set\(\[[\s\S]*?'booking_in_progress'[\s\S]*?'booking_released'/.test(fn)],
  ['function: booking email idempotency remains keyed by event', /p_event:\s*lifecycleEvent/.test(fn) && /primary key \(booking_id, event\)/i.test(fs.readFileSync('supabase/migrations/20261019000003_booking_email_deliveries.sql', 'utf8'))],
  ['function: status updates include payment details', /paymentBlock\(amounts, extractOcrDetails\(booking, payment\)\)/.test(shared)],
  ['function: receipts require verified payment status', /amounts\.verifiedGrossPaid > 0 && amounts\.verifiedRemainingBalance <= 0/.test(fn)],
  ['function: official receipt metadata comes from a verified payment', /const verifiedPayment: PaymentLike \| null = \[\.\.\.payments\][\s\S]*?status \|\| ''\)\.toUpperCase\(\) === 'PAID'/.test(fn)],
  ['function: explicit reinstatement event key is stable across retries', /booking_reinstated:\$\{result\.statusUpdatedAt\}/.test(adminBookingDetails)],
  ['shared: split verified payments aggregate to a settled booking', resolveAmounts(
    { total_amount: 1000 },
    { amount: 500, status: 'PAID' },
    [{ amount: 500, status: 'PAID' }, { amount: 500, status: 'PAID' }]
  ).verifiedRemainingBalance === 0],
  ['shared: unverified balance payment does not qualify for an official receipt', resolveAmounts(
    { total_amount: 1000 },
    { amount: 500, status: 'FOR_VERIFICATION' },
    [{ amount: 500, status: 'PAID' }, { amount: 500, status: 'FOR_VERIFICATION' }]
  ).verifiedRemainingBalance === 500],
  ['receipt: PDF uses the transaction receipt structure and transaction-level details', [
    '/BaseFont /Helvetica-Bold',
    'COMAR GARAGE',
    'OFFICIAL RECEIPT',
    'Receipt No. RCP-PAYMENT-123',
    'Transaction/Reference ID: TXN-12345',
    'BILLED TO',
    'WORK ORDER',
    'DESCRIPTION',
    'Payment for Booking',
    'Gross Paid',
    'PHP 1,000.00',
    'Transfer Fee',
    'PHP 100.00',
    'Net Received',
    'PHP 900.00',
    'PAYMENT RECEIPT',
  ].every((content) => receiptPdf.includes(content))],
  ['receipt: no booking lifecycle or refund status is printed', !/NO-SHOW|REFUND STATUS|REFUNDED|FLAGGED/.test(receiptPdf)],
  ['receipt: customer contact is separated from the table header', /48 580 516 25 re f/.test(receiptPdf) && /09123456789/.test(receiptPdf)],
  ['receipt: PDF cross-reference points to its actual byte offset', Number(receiptPdf.match(/startxref\n(\d+)/)?.[1]) === receiptPdf.indexOf('xref\n')],
  ['notification mailer: operational notifications stay in-app only', /EMAILABLE_NOTIFICATION_TYPES = new Set<string>\(\)/.test(notificationEmail)],
  ['event engine: all operational notifications are in-app only', !/sendNotificationEmail/.test(eventEngine)],
  ['event engine: chat notices without a booking link are suppressed', /if \(isChatMessage && !bookingId\)/.test(eventEngine)],
  ['notifications: unlinked chat and status updates are hidden', /BOOKING_CONTEXT_NOTIFICATION_TYPES[\s\S]*?'CHAT_MESSAGE'[\s\S]*?'STATUS_UPDATE'/.test(notificationRouting) && /Boolean\(notification\.booking_id\)/.test(notificationRouting)],
  ['notifications: database blocks unlinked chat and status updates', /before insert on public\.notifications/.test(notificationSuppressionMigration) && /new\.booking_id is null[\s\S]*?return null/.test(notificationSuppressionMigration)],
  ['customer billing: fetch callback is initialized before the effect uses it', customerBilling.indexOf('const fetchData = useCallback') >= 0 && customerBilling.indexOf('const fetchData = useCallback') < customerBilling.indexOf('useEffect(() =>')],
  ['customer booking: flagged no-show has its own visible lifecycle state', /normalizedStatus === 'FLAGGED_NOSHOW'[\s\S]*?Flagged no-show/.test(bookingSummaryHeader)],
  ['payment receipt: portal uses the shared transaction calculation model', /resolveTransactionReceiptAmounts\(selectedPayment\)/.test(officialReceipt) && /resolveTransactionReceiptAmounts/.test(receiptModel)],
  ['payment receipt: gross, fee, and net agree with receipt model', (() => {
    const amounts = resolveTransactionReceiptAmounts(samplePayment);
    return amounts.grossPaid === 1000 && amounts.transferFee === 100 && amounts.netReceived === 900;
  })()],
  ['invoice: discount is subtracted from the pre-discount subtotal exactly once', (() => {
    const amounts = resolveInvoiceAmounts({ total_amount: 900, discount_amount_snapshot: 100 });
    return amounts.subtotal === 1000 && amounts.discount === 100 && amounts.totalDue === 900;
  })()],
  ['customer ledger: displays separate transaction rows including pending verification', /'FOR_VERIFICATION', 'REJECTED'/.test(fs.readFileSync('frontend/src/pages/Customer/CustomerBilling.jsx', 'utf8'))],
  ['customer ledger: restores prior table layout', /Receipt No\. \/ Reference ID/.test(customerBilling) && /LINKED TO INV-/.test(customerBilling) && !/billing-ledger-reference-line/.test(customerBilling)],
  ['customer ledger: refund pending status stays on one line at all widths', /display: 'inline-block',[\s\S]*?whiteSpace: 'nowrap',[\s\S]*?\{statusLabel\}/.test(customerBilling)],
  ['customer ledger: only verified positive payments can open receipts', /canIssueReceipt = Number\(p\.amount\) > 0[\s\S]*?\['PAID', 'REFUND_PENDING', 'REFUNDED'\]/.test(fs.readFileSync('frontend/src/pages/Customer/CustomerBilling.jsx', 'utf8'))],
  ['payment receipts: portal labels receipt number and gateway reference separately', /getReceiptNumber\(selectedPayment\)/.test(officialReceipt) && /Transaction\/Reference ID/.test(officialReceipt)],
  ['payment receipts: do not fetch or display booking/refund status', !/refund_status|refund|payment_refund_allocations|isNoShow|FLAGGED_NOSHOW|NO-SHOW/.test(officialReceipt)],
  ['email receipt: uses transaction data only, not booking refund allocations', !/payment_refund_allocations|refundAllocations/.test(fn) && !/refund|bookingStatus|booking_status|no.show/i.test(fs.readFileSync('supabase/functions/_shared/officialReceiptPdf.ts', 'utf8'))],
  ['admin payment verification: no standalone receipt dispatch', !/sendPaymentReceiptEmail/.test(adminPayments) && !/sendPaymentReceiptEmail/.test(adminBookingDetails)],
  ['notification service: standalone receipt helper removed', !/sendPaymentReceiptEmail|\/api\/emails\/payment-receipt/.test(notificationService)],
  ['no-show worker: retries flagged bookings without requiring a profile email', /from\('bookings'\)[\s\S]*?\.select\('id, refund_status, customer_email, payments\(amount, detected_amount, status, method, verified_at\)'\)[\s\S]*?\.eq\('status', 'FLAGGED_NOSHOW'\)/.test(backend)],
  ['no-show email: includes queued refund status and amounts', /Refund status: \$\{booking\.refund_status \|\| 'QUEUED'\}[\s\S]*?Verified payments awaiting refund[\s\S]*?Unverified payment claims awaiting review/.test(backend)],
  ['cancellation: refund state and audit are committed in the database RPC', /update public\.payments[\s\S]*?set status = 'REFUND_PENDING'/.test(cancellationMigration) && /insert into public\.audit_logs/.test(cancellationMigration)],
  ['cancellation: both admin endpoints use the atomic cancellation RPC', /rpc\('admin_cancel_booking'/.test(backend) && /cancelBookingAndQueueRefund\(\{[\s\S]*?bookingId,[\s\S]*?reason/.test(backend)],
  ['booking directory: exposes cancellation on mobile and desktop', (adminBookings.match(/requestCancelBooking\(booking\)/g) || []).length >= 2],
  ['booking directory: hides cancellation after service starts', /const canCancel = \(booking\) => \{[\s\S]*?'in_progress', 'ongoing'[\s\S]*?vehicleStatuses\.some/.test(adminBookings)],
  ['cancellation: database rejects started or completed vehicle service', /'in_progress', 'ongoing', 'completed', 'released', 'cancelled'[\s\S]*?from public\.booking_vehicles[\s\S]*?'IN_PROGRESS', 'ONGOING', 'COMPLETED', 'RELEASED'/.test(cancellationMigration)],
  ['cancellation: audit records actor, reason, status transition, and refund details', /'BOOKING_CANCELLED'[\s\S]*?p_actor_id[\s\S]*?btrim\(p_reason\)[\s\S]*?'previous_status', v_booking\.status::text[\s\S]*?'new_status', 'CANCELLED'[\s\S]*?'cancellation_reason', btrim\(p_reason\)[\s\S]*?'refund_amount'/.test(cancellationMigration)],
  ['cancellation: admin and customer use one authenticated endpoint and transaction', /app\.post\('\/api\/bookings\/cancel'/.test(backend) && /getCancellationActor\(req\)[\s\S]*?cancelBookingAndQueueRefund/.test(backend) && /p_actor_role: actor\.profile\?\.role/.test(backend)],
  ['cancellation: customers can cancel only bookings linked to their own account', /actor\.profile\.role === 'CUSTOMER'[\s\S]*?\.select\('id, customer_id'\)[\s\S]*?booking\.customer_id !== actor\.profile\.id/.test(backend)],
  ['cancellation: customer ownership is rechecked inside the database transaction', /v_booking\.customer_id is distinct from p_actor_id[\s\S]*?BOOKING_NOT_OWNED_BY_CUSTOMER/.test(cancellationMigration)],
  ['customer cancellation: uses authenticated shared backend endpoint, not direct table updates', /fetch\(`\$\{BACKEND_URL\}\/api\/bookings\/cancel`/.test(fs.readFileSync('frontend/src/services/bookingService.js', 'utf8')) && !/from\('bookings'\)[\s\S]*?\.update\(\{\s*status: 'cancelled'/.test(fs.readFileSync('frontend/src/services/bookingService.js', 'utf8'))],
  ['customer cancellation: scheduled and confirmed bookings can cancel before service starts', /const canCancelBooking = \['scheduled', 'confirmed'\]\.includes\(derivedStatus\)[\s\S]*?vehicleStatuses\.some[\s\S]*?'IN_PROGRESS', 'ONGOING', 'COMPLETED', 'RELEASED'/.test(fs.readFileSync('frontend/src/pages/Customer/CustomerBookingDetails.jsx', 'utf8')) && /canCancelBooking && \(/.test(fs.readFileSync('frontend/src/pages/Customer/CustomerBookingDetails.jsx', 'utf8'))],
  ['audit page: cancellation is listed with its reason', /BOOKING_CANCELLED: \{ category: 'BOOKINGS', title: 'Booking cancelled' \}/.test(fs.readFileSync('frontend/src/pages/Admin/AdminAuditLogs.jsx', 'utf8')) && /case 'BOOKING_CANCELLED':[\s\S]*?reason: \{B\(details/.test(fs.readFileSync('frontend/src/pages/Admin/AdminAuditLogs.jsx', 'utf8'))],
  ['cancellation: customer email dispatch is centralized after refund details are prepared', /dispatchLifecycleEmail\([\s\S]*?'CANCELLED'[\s\S]*?refundDetails/.test(backend) && !/sendStatusEmail\(id, 'CANCELLED'/.test(adminBookingDetails)],
);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
}

console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);