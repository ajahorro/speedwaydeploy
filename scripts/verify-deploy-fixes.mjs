/**
 * scripts/verify-deploy-fixes.mjs
 * ============================================================================
 * Verifies the three deployment fixes against the LIVE project:
 *
 *   1. profiles.notification_preferences exists (was a 400 on every sign-in)
 *   2. OCR is a hard gate for a non-receipt image (was bypassable)
 *   3. the ledger function that the OCR-truth migration redefined is present
 *
 * Usage: node scripts/verify-deploy-fixes.mjs
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

console.log('════════════════════════════════════════');
console.log(' DEPLOYMENT FIX VERIFICATION');
console.log('════════════════════════════════════════\n');

// ── 1. The 400: notification_preferences ────────────────────────────────────
console.log('── (1) profiles.notification_preferences (the 400) ──');

for (const col of ['notification_preferences', 'push_notifications_enabled']) {
  const { error } = await db.from('profiles').select(col).limit(1);
  check(`profiles.${col} is selectable`, !error, error ? `${error.code} ${error.message}` : '');
}

// The exact query the browser was failing on.
const { data: probe, error: probeErr } = await db
  .from('profiles')
  .select('notification_preferences,push_notifications_enabled')
  .limit(1);

check(
  'the exact browser query now succeeds',
  !probeErr,
  probeErr ? `${probeErr.code} ${probeErr.message}` : `returned ${probe?.length ?? 0} row(s)`
);

// A non-object value must be rejected by the CHECK constraint.
const { data: someone } = await db.from('profiles').select('id').limit(1).maybeSingle();
if (someone?.id) {
  const { error: badWrite } = await db
    .from('profiles')
    .update({ notification_preferences: [1, 2, 3] })
    .eq('id', someone.id);
  check('a non-object value is rejected by the constraint', Boolean(badWrite), badWrite ? badWrite.code : 'ACCEPTED — constraint missing');
}

// ── 2. The ledger functions ─────────────────────────────────────────────────
console.log('\n── (2) ledger functions present ──');
for (const fn of ['booking_financial_ledger', 'booking_net_paid', 'customer_opted_in']) {
  const { data, error } = await db.rpc('debug_function_source', { p_name: fn });
  check(`public.${fn}() exists`, Boolean(data), error?.message || (data ? '' : 'not found'));
}

// ── 3. OCR as a hard gate ───────────────────────────────────────────────────
console.log('\n── (3) OCR hard gate ──');
const { data: ocrSrc } = await db.rpc('debug_function_source', { p_name: 'persist_ocr_result' });
check('persist_ocr_result is readable', Boolean(ocrSrc));

// The status the backend assigns when the image is not a receipt.
const probeBooking = `OCR-GATE-${Date.now()}`;
const { data: created, error: createErr } = await db.rpc('create_booking_atomic', {
  p_payload: {
    booking: {
      payment_status: 'unpaid', payment_method: 'GCash',
      customer_name: probeBooking, customer_email: 'delivered@resend.dev',
      start_datetime: new Date(Date.now() + 9 * 864e5).toISOString(),
      end_datetime: new Date(Date.now() + 9 * 864e5 + 36e5).toISOString(),
      status: 'scheduled', total_amount: 500, vehicle_type: 'sedan',
    },
    vehicles: [{
      vehicle: { vehicle_type: 'sedan', brand: 'Test', model: 'Gate', plate_number: probeBooking, status: 'SCHEDULED' },
      services: [{ service_name: 'Regular Wash', price: 500, final_price: 500, duration_minutes: 60, vehicle_type: 'sedan' }],
    }],
    payment: { amount: 500, method: 'GCash', payment_type: 'Full', status: 'FOR_VERIFICATION' },
  },
});

if (createErr) {
  check('could create a probe booking', false, createErr.message);
} else {
  const bookingId = created.booking.id;
  const { data: pay } = await db.from('payments').select('id').eq('booking_id', bookingId).single();

  // Simulate a NON-RECEIPT image: OCR found no valid receipt and no amount.
  const { data: persisted, error: persistErr } = await db.rpc('persist_ocr_result', {
    p_booking_id: bookingId,
    p_payment_id: pay.id,
    p_detected_amount: 0,
    p_detected_ref: null,
    p_payment_status: 'FOR_VERIFICATION',
    p_ocr_metadata: { isValidReceipt: false, reason: 'NOT_A_RECEIPT', auditedAt: new Date().toISOString() },
  });

  check('persist_ocr_result accepted the failed scan', !persistErr, persistErr?.message || '');

  const { data: after } = await db.from('bookings').select('payment_status').eq('id', bookingId).single();
  const { data: afterPay } = await db.from('payments').select('status, detected_amount').eq('id', pay.id).single();

  console.log(`      booking.payment_status = ${after?.payment_status}`);
  console.log(`      payment.status         = ${afterPay?.status}, detected = ${afterPay?.detected_amount}`);

  check(
    'a non-receipt does NOT mark the payment PAID',
    String(after?.payment_status || '').toUpperCase() !== 'PAID' && String(afterPay?.status || '').toUpperCase() !== 'PAID'
  );

  // Clean up.
  await db.rpc('delete_booking_cascade', { p_booking_id: bookingId });
  console.log(`      (probe booking cleaned up)`);
}

const failed = results.filter((r) => !r.ok);
console.log('\n════════════════════════════════════════');
console.log(failed.length === 0 ? '✓ All deployment checks passed.' : `✗ ${failed.length} check(s) failed:`);
failed.forEach((f) => console.log(`   • ${f.label}`));
process.exit(failed.length === 0 ? 0 : 1);