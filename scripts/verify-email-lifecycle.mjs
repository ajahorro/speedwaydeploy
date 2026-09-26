/**
 * scripts/verify-email-lifecycle.mjs
 * ============================================================================
 * End-to-end verification of the booking email lifecycle against the LIVE
 * project. Asserts the two things that were actually broken:
 *
 *   1. EXACTLY ONE email per event. A duplicate invocation for the same
 *      (booking, event) must be REFUSED by the database, not merely avoided by
 *      convention.
 *
 *   2. The email reflects the REAL OCR data. The receipt reference, sender and
 *      detected amount from payments.ocr_metadata must appear in the rendered
 *      HTML — previously the emails read none of it.
 *
 * Also asserts the money figures match what was paid, and that the receipt PDF
 * is attached to the CONFIRMATION email (and NOT to the submission email).
 *
 * Usage: node scripts/verify-email-lifecycle.mjs
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

for (const envFile of ['backend/.env', 'frontend/.env']) {
  const p = path.join(repoRoot, envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const results = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  results.push({ label, ok });
};

// Resend (and most providers) REFUSES arbitrary domains such as example.com in
// test mode, which made this script unable to exercise the send path at all.
// Override with VERIFY_EMAIL when running against a real inbox.
const TEST_EMAIL = process.env.VERIFY_EMAIL || 'delivered@resend.dev';
const stamp = `LIFECYCLE-${Date.now()}`;

const invoke = async (body) => {
  const r = await fetch(`${process.env.SUPABASE_URL}/functions/v1/booking-lifecycle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  console.log('════════════════════════════════════════');
  console.log(' BOOKING EMAIL LIFECYCLE VERIFICATION');
  console.log('════════════════════════════════════════\n');

  // ── Create a booking with a payment carrying REAL OCR metadata ───────────
  const OCR_REF = `REF-${Date.now()}`;
  const { data, error } = await db.rpc('create_booking_atomic', {
    p_payload: {
      booking: {
        payment_status: 'unpaid',
        payment_method: 'GCash',
        customer_name: stamp,
        customer_email: TEST_EMAIL,
        start_datetime: new Date(Date.now() + 9 * 864e5).toISOString(),
        end_datetime: new Date(Date.now() + 9 * 864e5 + 36e5).toISOString(),
        status: 'scheduled',
        total_amount: 250,
        vehicle_type: 'sedan',
      },
      vehicles: [{
        vehicle: { vehicle_type: 'sedan', brand: 'Toyota', model: 'Vios', plate_number: stamp, status: 'SCHEDULED' },
        services: [{ service_name: 'Regular Wash', price: 250, final_price: 250, duration_minutes: 60, vehicle_type: 'sedan' }],
      }],
      payment: {
        amount: 250,
        method: 'GCash',
        payment_type: 'Full',
        status: 'FOR_VERIFICATION',
        detected_amount: 250,
        detected_ref: OCR_REF,
        transfer_fee: 0,
        net_credit: 250,
      },
    },
  });

  if (error) {
    console.error('✗ Could not create the test booking:', error.message);
    process.exit(1);
  }

  const bookingId = data.booking.id;

  // Write the OCR metadata exactly where persist_ocr_result puts it: the rich
  // metadata lives on the BOOKING. Writing it to payments was the defect that
  // made the emails unable to read any OCR detail.
  const { data: payRow } = await db.from('payments').select('id').eq('booking_id', bookingId).single();
  await db.from('bookings').update({
    ocr_metadata: {
      amount: 250,
      grossAmount: 250,
      transferFee: 0,
      referenceNumber: OCR_REF,
      timestamp: new Date().toISOString(),
      isValidReceipt: true,
      recipient: 'SPEEDWAY AUTOXMOTO',
      description: 'GCash transfer',
      isAmountMatch: true,
      isDuplicate: false,
      auditedAt: new Date().toISOString(),
    },
  }).eq('id', bookingId);

  const { data: booking } = await db.from('bookings').select('total_amount, start_datetime, status').eq('id', bookingId).single();
  console.log(`Test booking ${bookingId}`);
  console.log(`  total_amount  = ${booking.total_amount}`);
  console.log(`  start_datetime= ${booking.start_datetime}`);
  console.log(`  OCR reference = ${OCR_REF}\n`);

  check('booking payload persisted (not nulled)', Number(booking.total_amount) === 250 && Boolean(booking.start_datetime));

  // ── 1. The submission email ──────────────────────────────────────────────
  console.log('── Event 1: booking_created ──');
  const first = await invoke({ bookingId, event: 'booking_created' });
  check('sent', first.status === 200 && first.body.ok === true, JSON.stringify(first.body).slice(0, 160));
  check('no receipt attached to the submission email', first.body.attachments === 0, `attachments=${first.body.attachments}`);
  check('subject quotes the amount paid', /250/.test(first.body.subject || ''), first.body.subject);

  // ── 2. Duplicate suppression — the actual flood fix ──────────────────────
  console.log('\n── Duplicate suppression (the flood fix) ──');
  const second = await invoke({ bookingId, event: 'booking_created' });
  check('a repeat send is REFUSED, not re-sent', second.body.skipped === true, JSON.stringify(second.body).slice(0, 160));
  check('the refusal names the reason', ['ALREADY_SENT', 'RACE_LOST'].includes(second.body.reason), second.body.reason);

  const third = await invoke({ bookingId, event: 'scheduled' });
  check('a differently-spelled duplicate maps to the same event and is refused', third.body.skipped === true, third.body.reason);

  // Concurrent duplicates: the DB must allow exactly one winner.
  const race = await Promise.all([
    invoke({ bookingId, event: 'booking_in_progress' }),
    invoke({ bookingId, event: 'booking_in_progress' }),
    invoke({ bookingId, event: 'booking_in_progress' }),
  ]);
  const sentCount = race.filter((r) => r.body.ok && !r.body.skipped).length;
  const skippedCount = race.filter((r) => r.body.skipped).length;
  check('3 concurrent sends => exactly 1 delivered, 2 refused', sentCount === 1 && skippedCount === 2, `sent=${sentCount} skipped=${skippedCount}`);

  // ── 3. The confirmation email carries the receipt ────────────────────────
  console.log('\n── Event 2: booking_confirmed (carries the receipt) ──');
  await db.from('payments').update({ status: 'PAID' }).eq('id', payRow.id);
  const confirmed = await invoke({ bookingId, event: 'booking_confirmed' });
  check('sent', confirmed.status === 200 && confirmed.body.ok === true, JSON.stringify(confirmed.body).slice(0, 160));
  check('receipt PDF ATTACHED to the confirmation email', confirmed.body.attachments === 1, `attachments=${confirmed.body.attachments}`);

  const confirmAgain = await invoke({ bookingId, event: 'booking_confirmed' });
  check('a second confirmation does not re-send the receipt', confirmAgain.body.skipped === true, confirmAgain.body.reason);

  // ── 4. The delivery ledger ───────────────────────────────────────────────
  console.log('\n── Delivery ledger ──');
  const { data: deliveries } = await db
    .from('booking_email_deliveries')
    .select('event, recipient, sent_at')
    .eq('booking_id', bookingId)
    .order('sent_at');

  check('one ledger row per distinct event', (deliveries?.length || 0) === 3, `${deliveries?.length || 0} rows: ${(deliveries || []).map((d) => d.event).join(', ')}`);
  check('ledger records the recipient', deliveries?.every((d) => d.recipient === TEST_EMAIL) === true);

  // ── 5. The OCR data reaches the rendered HTML ────────────────────────────
  console.log('\n── OCR data must appear in the email ──');
  const { buildBookingCreatedEmail, extractOcrDetails } = await import('../supabase/functions/_shared/bookingEmail.ts')
    .catch(() => ({}));

  if (buildBookingCreatedEmail) {
    const { data: fullBooking } = await db
      .from('bookings')
      .select('*, vehicles:booking_vehicles(*, services:booking_vehicle_services(*)), payments:payments!payments_booking_id_fkey(*)')
      .eq('id', bookingId)
      .single();
    const pay = (fullBooking.payments || [])[0];
    const built = buildBookingCreatedEmail({ booking: fullBooking, payment: pay, customerName: stamp });
    // extractOcrDetails takes (booking, payment): the metadata is on the booking.
    const ocr = extractOcrDetails(fullBooking, pay);

    check('OCR reference is extracted', ocr.reference === OCR_REF, ocr.reference || '(none)');
    check('OCR sender is extracted', ocr.sender === 'SPEEDWAY AUTOXMOTO', ocr.sender || '(none)');
    check('OCR transaction date is extracted', Boolean(ocr.transactionAt), ocr.transactionAt || '(none)');
    check('OCR reference renders in the HTML', built.html.includes(OCR_REF));
    check('OCR sender renders in the HTML', built.html.includes('SPEEDWAY AUTOXMOTO'));
    check('email does NOT quote ₱280 (VAT-on-top bug)', !built.html.includes('280.00'));
  } else {
    check('shared email module importable by the verifier', false, 'Deno-style .ts import not resolvable from Node');
  }

  // Clean up.
  await db.from('bookings').delete().eq('id', bookingId);
  console.log(`\n  (test booking ${bookingId} cleaned up)`);

  const failed = results.filter((r) => !r.ok);
  console.log('\n════════════════════════════════════════');
  console.log(failed.length === 0 ? '✓ All lifecycle checks passed.' : `✗ ${failed.length} check(s) failed:`);
  failed.forEach((f) => console.log(`   • ${f.label}`));
  process.exit(failed.length === 0 ? 0 : 1);
})();