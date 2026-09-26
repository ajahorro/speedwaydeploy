/**
 * scripts/verify-ocr-gate.mjs
 * ============================================================================
 * Proves the OCR is now a HARD GATE: a non-receipt image can no longer produce a
 * booking, and a clean receipt still lands in verification (never auto-paid).
 *
 * The reported bypass was not one bug but three, so this tests the OUTCOME
 * rather than any single mechanism:
 *
 *   1. the verdict was written with human-readable text against an enum (42804),
 *      and the error was only logged;
 *   2. the persistence call was skipped entirely when no booking existed yet;
 *   3. nothing in the database required the stored verdict to agree with the
 *      booking, so the client's own `payment_status` was trusted.
 *
 * Usage: node scripts/verify-ocr-gate.mjs
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

/** Builds a booking payload carrying an OCR verdict. */
const payload = (stamp, verdict, paymentOver = {}) => ({
  booking: {
    payment_status: 'unpaid',
    payment_method: 'GCash',
    customer_name: stamp,
    customer_email: 'delivered@resend.dev',
    start_datetime: new Date(Date.now() + 9 * 864e5).toISOString(),
    end_datetime: new Date(Date.now() + 9 * 864e5 + 36e5).toISOString(),
    status: 'scheduled',
    total_amount: 500,
    vehicle_type: 'sedan',
  },
  vehicles: [{
    vehicle: { vehicle_type: 'sedan', brand: 'Test', model: 'Gate', plate_number: stamp, status: 'SCHEDULED' },
    services: [{ service_name: 'Regular Wash', price: 500, final_price: 500, duration_minutes: 60, vehicle_type: 'sedan' }],
  }],
  payment: {
    amount: 500, method: 'GCash', payment_type: 'Full',
    // The verdict from the pre-submit OCR scan.
    verdict,
    status: verdict,
    detected_amount: 500, detected_ref: `REF-${Date.now()}`,
    transfer_fee: 0, net_credit: 500,
    ...paymentOver,
  },
});

const create = (stamp, verdict, paymentOver) => db.rpc('create_booking_atomic', { p_payload: payload(stamp, verdict, paymentOver) });

const cleanups = [];
const cleanup = async () => {
  for (const id of cleanups) await db.rpc('delete_booking_cascade', { p_booking_id: id });
};

console.log('════════════════════════════════════════');
console.log(' OCR HARD-GATE VERIFICATION');
console.log('════════════════════════════════════════\n');

// ── A: a REJECTED receipt (the non-receipt image) must be refused ───────────
console.log('── A non-receipt image must NOT produce a booking ──');

const stampA = `GATE-REJECT-${Date.now()}`;
const a = await create(stampA, 'REJECTED', { detected_amount: 0, detected_ref: null });

check('the booking is REFUSED', Boolean(a.error), a.error ? `${a.error.code}: ${a.error.message.slice(0, 90)}` : 'BOOKING WAS CREATED — gate failed');

if (!a.error) {
  if (a.data?.booking?.id) cleanups.push(a.data.booking.id);
} else {
  check('the refusal is a check_violation, not a crash', a.error.code === '23514', a.error.code);
  check('the message tells the customer what to do', /valid payment receipt/i.test(a.error.message), '');
}

// Confirm no row actually landed.
const { data: leftoverA } = await db.from('bookings').select('id').eq('customer_name', stampA);
check('no booking row exists after the refusal', (leftoverA?.length || 0) === 0, `${leftoverA?.length || 0} row(s)`);

// ── B: a customer may not claim a settled payment ───────────────────────────
console.log('\n── A customer may not self-declare a paid booking ──');
const stampB = `GATE-PAID-${Date.now()}`;
const b = await create(stampB, 'PAID');
check('a PAID payment in a customer booking is refused', Boolean(b.error), b.error ? b.error.message.slice(0, 90) : 'ACCEPTED — gate failed');
if (b.data?.booking?.id) cleanups.push(b.data.booking.id);

// ── C: a clean receipt still works, and still waits for verification ────────
console.log('\n── A clean receipt still books, and still waits for a human ──');
const stampC = `GATE-OK-${Date.now()}`;
const c = await create(stampC, 'FOR_VERIFICATION');

check('the booking is created', !c.error && Boolean(c.data?.booking?.id), c.error?.message?.slice(0, 90) || '');

if (c.data?.booking?.id) {
  cleanups.push(c.data.booking.id);
  const { data: row } = await db.from('bookings').select('payment_status').eq('id', c.data.booking.id).single();
  check('booking.payment_status is a valid enum member', ['unpaid', 'pending', 'paid', 'refunded'].includes(String(row?.payment_status)), String(row?.payment_status));
  check('the customer receipt did NOT auto-settle the booking', String(row?.payment_status) !== 'paid', String(row?.payment_status));
  check('it is awaiting verification (pending)', String(row?.payment_status) === 'pending', String(row?.payment_status));

  const { data: pay } = await db.from('payments').select('id, status').eq('booking_id', c.data.booking.id).single();
  check('the payment row is FOR_VERIFICATION', String(pay?.status).toUpperCase() === 'FOR_VERIFICATION', pay?.status);

  // The verdict reader must resolve without error.
  const { data: verdict, error: vErr } = await db.rpc('payment_ocr_verdict', { p_payment_id: pay.id });
  check('payment_ocr_verdict() resolves', !vErr, vErr?.message?.slice(0, 90) || '');
  if (verdict) console.log(`      verdict: ${JSON.stringify(verdict).slice(0, 160)}`);
}

// ── D: the helper maps verdicts the way the columns require ────────────────
console.log('\n── verdict -> booking status mapping ──');
for (const [input, expected] of [
  ['FOR_VERIFICATION', 'pending'],
  ['REJECTED', 'rejected'],
  ['PAID', 'paid'],
  ['UNPAID', 'unpaid'],
]) {
  const { data, error } = await db.rpc('derive_booking_payment_status', { p_payment_status: input, p_payment_verdict: null });
  check(`${input} -> ${expected}`, !error && data === expected, error?.message || String(data));
}

// ── E: a forged/unknown verdict must not reach the enum ────────────────────
console.log('\n── An unrecognised verdict is refused ──');
const stampE = `GATE-BOGUS-${Date.now()}`;
const e = await create(stampE, 'Confirmed');
check('the legacy "Confirmed" string is refused', Boolean(e.error), e.error ? e.error.message.slice(0, 90) : 'ACCEPTED — allow-list missing');
if (e.data?.booking?.id) cleanups.push(e.data.booking.id);

const stampF = `GATE-NOVERDICT-${Date.now()}`;
const f = await create(stampF, '');
check('a missing verdict is refused (no unscanned bookings)', Boolean(f.error), f.error ? f.error.message.slice(0, 90) : 'ACCEPTED — no verdict required');
if (f.data?.booking?.id) cleanups.push(f.data.booking.id);

await cleanup();
console.log(`\n  (cleaned ${cleanups.length} probe booking(s))`);

const failed = results.filter((r) => !r.ok);
console.log('\n════════════════════════════════════════');
console.log(failed.length === 0 ? '✓ OCR gate holds.' : `✗ ${failed.length} check(s) failed:`);
failed.forEach((f) => console.log(`   • ${f.label}`));
process.exit(failed.length === 0 ? 0 : 1);