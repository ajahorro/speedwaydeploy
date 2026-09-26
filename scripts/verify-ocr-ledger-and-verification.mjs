/**
 * scripts/verify-ocr-ledger-and-verification.mjs
 * ============================================================================
 * Checks the two requirements:
 *
 *   (A) The OCR output must reach the booking's OVERALL FINANCIAL LEDGER, not
 *       just the pipeline.
 *   (B) A customer-made booking must still land in payment VERIFICATION
 *       (FOR_VERIFICATION), never auto-PAID.
 *
 * ── THE FINDING THIS SCRIPT EXISTS TO PROVE ─────────────────────────────────
 * These two requirements CONFLICT, and the conflict is the real defect.
 *
 * The financial ledger (booking_net_paid / calculatePaymentSummary) counts a
 * payment as money received ONLY when payments.status is one of
 * PAID | REFUND_PENDING | REFUNDED. FOR_VERIFICATION is deliberately NOT in that
 * set.
 *
 * So today, a customer's OCR-verified receipt is written to
 * payments.detected_amount / detected_ref and bookings.ocr_metadata, but the
 * payment row stays FOR_VERIFICATION — which means **₱0 of it appears in the
 * ledger**. The OCR output demonstrably does NOT reflect in the financial total,
 * because the ledger is correct to exclude unverified money.
 *
 * The fix is NOT to make the ledger count unverified money (that would let an
 * unverified receipt inflate recognised revenue). It is to make the OCR output
 * visible in the ledger as an ATTRIBUTION layer:
 *
 *     Settled money      -> affects totals       (unchanged: PAID only)
 *     OCR-attributed money -> shown against the line, marked pending
 *                            (new: detected_amount vs declared, with the delta)
 *
 * This script measures both halves so the claim is evidence-backed.
 *
 * Usage: node scripts/verify-ocr-ledger-and-verification.mjs
 * ============================================================================
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const f of ['backend/.env']) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
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

/** Mirrors the canonical ledger rule (frontend/src/utils/paymentUtils.js). */
const LEDGER_STATUSES = ['PAID', 'REFUND_PENDING', 'REFUNDED'];
const ledgerContribution = (payment) => {
  const status = String(payment.status || '').toUpperCase();
  const isRefund = String(payment.method || '').toUpperCase() === 'SYSTEM_REFUND';
  if (isRefund || Number(payment.amount) <= 0) return 0;
  return LEDGER_STATUSES.includes(status) ? Number(payment.amount) : 0;
};

const stamp = `OCR-LEDGER-${Date.now()}`;

(async () => {
  console.log('════════════════════════════════════════');
  console.log(' OCR -> FINANCIAL LEDGER + VERIFICATION GATE');
  console.log('════════════════════════════════════════\n');

  // ── A customer self-service booking with an OCR-scanned receipt ───────────
  const { data, error } = await db.rpc('create_booking_atomic', {
    p_payload: {
      booking: {
        payment_status: 'unpaid',
        payment_method: 'GCash',
        customer_name: stamp,
        customer_email: 'delivered@resend.dev',
        start_datetime: new Date(Date.now() + 9 * 864e5).toISOString(),
        end_datetime: new Date(Date.now() + 9 * 864e5 + 36e5).toISOString(),
        status: 'scheduled',
        total_amount: 1000,
        vehicle_type: 'sedan',
      },
      vehicles: [{
        vehicle: { vehicle_type: 'sedan', brand: 'Toyota', model: 'Vios', plate_number: stamp, status: 'SCHEDULED' },
        services: [{ service_name: 'Regular Wash', price: 1000, final_price: 1000, duration_minutes: 60, vehicle_type: 'sedan' }],
      }],
      // The customer DECLARED 1000 but the receipt OCRs as 980 (a fee was taken
      // in transit). This divergence is exactly what the ledger must expose.
      payment: {
        amount: 1000,
        method: 'GCash',
        payment_type: 'Full',
        status: 'FOR_VERIFICATION',
        detected_amount: 980,
        detected_ref: `OCR-REF-${Date.now()}`,
        transfer_fee: 20,
        net_credit: 980,
      },
    },
  });

  if (error) {
    console.error('✗ Could not create the test booking:', error.message);
    process.exit(1);
  }

  const bookingId = data.booking.id;

  const { data: pay } = await db.from('payments').select('*').eq('booking_id', bookingId).single();
  const { data: bk } = await db.from('bookings').select('*').eq('id', bookingId).single();

  console.log(`Booking ${bookingId}  (total ₱${bk.total_amount})`);
  console.log(`  declared      ₱${pay.amount}`);
  console.log(`  OCR detected  ₱${pay.detected_amount}  (net the shop received)`);
  console.log(`  transfer fee  ₱${pay.transfer_fee}`);
  console.log(`  status        ${pay.status}\n`);

  // ── REQUIREMENT (B): still in verification ────────────────────────────────
  console.log('── (B) Customer booking must be in VERIFICATION ──');
  check('payment status is FOR_VERIFICATION', String(pay.status).toUpperCase() === 'FOR_VERIFICATION', pay.status);
  check('booking payment_status is not PAID', String(bk.payment_status || '').toUpperCase() !== 'PAID', bk.payment_status);
  check('OCR did not silently promote the payment to PAID', !/PAID/.test(String(pay.status || '').toUpperCase()));

  // ── REQUIREMENT (A): OCR output in the ledger ────────────────────────────
  console.log('\n── (A) OCR output must reflect in the financial ledger ──');
  const contribution = ledgerContribution(pay);
  console.log(`      ledger contribution of this payment: ₱${contribution}`);

  check(
    'the ledger does NOT count unverified money as settled',
    contribution === 0,
    'uncounted while FOR_VERIFICATION is CORRECT — the fix is to surface it separately'
  );

  // This is the requirement gap, measured rather than assumed.
  const { data: fnSource } = await db.rpc('debug_function_source', { p_name: 'booking_financial_ledger' });
  const ledgerFunctionExists = Boolean(fnSource);
  check(
    'an OCR-attribution ledger view/function exists',
    ledgerFunctionExists,
    ledgerFunctionExists
      ? 'present'
      : 'MISSING — the OCR amount is invisible to the ledger today (this is the gap)'
  );

  if (ledgerFunctionExists) {
    const { data: ledger, error: ledgerErr } = await db.rpc('booking_financial_ledger', { p_booking_id: bookingId });
    check('ledger resolves for the booking', !ledgerErr, ledgerErr?.message || '');
    if (ledger) {
      console.log('      ledger:', JSON.stringify(ledger));
      check('ledger separates settled from pending', 'pending_verification' in ledger && 'settled_amount' in ledger);
      // Field names are explicit by design: 'pending_ocr_detected' is what the
      // scan read, 'pending_declared' is what the customer claimed. They are
      // never merged, so a caller cannot read one as the other.
      check('ledger exposes the OCR-scanned amount', Number(ledger.pending_ocr_detected) === 980, String(ledger.pending_ocr_detected));
      check('ledger exposes the customer-declared amount', Number(ledger.pending_declared) === 1000, String(ledger.pending_declared));
      check('ledger exposes the declared-vs-OCR variance', Number(ledger.ocr_variance) === 20, String(ledger.ocr_variance));
      check('ledger flags the discrepancy for an admin', ledger.has_discrepancy === true);
      check('settled total excludes the unverified payment', Number(ledger.settled_amount) === 0, String(ledger.settled_amount));
      check('unverified money cannot read as fully settled', ledger.fully_settled === false);
      check('outstanding balance ignores the unverified claim', Number(ledger.outstanding_amount) === 1000, String(ledger.outstanding_amount));
      check('the ledger states its own recognition rule', typeof ledger.ledger_rule === 'string' && ledger.ledger_rule.includes('FOR_VERIFICATION is excluded'));
    }
  }

  await db.rpc('delete_booking_cascade', { p_booking_id: bookingId });
  console.log(`\n  (test booking ${bookingId} cleaned up)`);

  const failed = results.filter((r) => !r.ok);
  console.log('\n════════════════════════════════════════');
  console.log(failed.length === 0 ? '✓ All checks passed.' : `✗ ${failed.length} check(s) failed:`);
  failed.forEach((f) => console.log(`   • ${f.label}`));
  process.exit(failed.length === 0 ? 0 : 1);
})();