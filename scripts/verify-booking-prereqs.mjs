#!/usr/bin/env node
/**
 * scripts/verify-booking-prereqs.mjs
 * ============================================================================
 * Verifies the LIVE database actually has every object the booking submit path
 * depends on — and that create_booking_atomic()'s SOURCE contains the enum casts
 * the client relies on.
 *
 * WHY: `npx supabase migration list` shows a version in the LOCAL folder and a
 * version in the REMOTE ledger. Those two can disagree with REALITY: a migration
 * may be recorded as applied while its DDL never landed (a `do $$` patch that
 * silently hit its "anchor not found" branch, or a file applied by hand without
 * updating the ledger). The only trustworthy check is introspection of the live
 * schema via pg_get_functiondef().
 *
 * USAGE
 *   node scripts/verify-booking-prereqs.mjs
 * Exit 0 = booking prerequisites satisfied. Exit 1 = drift found.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

for (const envFile of ['backend/.env', '.env']) {
  const p = path.join(repoRoot, envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (checked backend/.env, .env).');
  process.exit(2);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

/** Column existence via a zero-row PostgREST select. */
async function hasColumn(table, column) {
  const { error } = await db.from(table).select(column).limit(1);
  return { ok: !error, detail: error?.message };
}

/** Function bodies are not exposed via PostgREST, so we ask a SECURITY DEFINER helper. */
async function functionDef(name) {
  const { data, error } = await db.rpc('debug_function_source', { p_name: name });
  if (error) return { ok: false, detail: error.message, src: null };
  return { ok: Boolean(data), src: data };
}

(async () => {
  console.log('════════════════════════════════════════');
  console.log(' BOOKING SUBMIT PREREQUISITE VERIFIER');
  console.log(' Target:', SUPABASE_URL);
  console.log('════════════════════════════════════════\n');

  console.log('── create_booking_atomic() exists ──');
  const rpcProbe = await db.rpc('create_booking_atomic', { p_payload: { booking: {}, vehicles: [] } });
  const fnMissing = /could not find the function|does not exist|schema cache/i.test(rpcProbe.error?.message || '');
  check('public.create_booking_atomic()', !fnMissing, rpcProbe.error?.message?.slice(0, 120));

  console.log('\n── Columns the booking insert writes ──');
  for (const [t, c] of [
    ['bookings', 'vehicle_type'], ['bookings', 'bay_id'],
    ['booking_vehicles', 'fleet_group_id'], ['booking_vehicles', 'service_notes'],
    ['booking_vehicle_services', 'service_id'], ['booking_vehicle_services', 'step_order'],
    ['business_config', 'unpaid_hold_minutes'], ['business_config', 'is_24_7'],
    ['bookings', 'cancellation_type'],
  ]) {
    const r = await hasColumn(t, c);
    check(`${t}.${c}`, r.ok, r.detail?.slice(0, 100));
  }

  console.log('\n── Function sources (does the LIVE body contain the enum casts?) ──');
  const src = await functionDef('create_booking_atomic');
  if (!src.ok) {
    check('read create_booking_atomic() source', false, src.detail?.slice(0, 160));
  } else {
    check('body casts payment_status', /v_payment_status|::booking_payment_status|booking_payment_status/.test(src.src));
    check('body casts payment_method', /v_payment_method|payment_method_type/.test(src.src));
    check('body casts vehicle_type', /v_vehicle_type|::vehicle_type|normalize_vehicle_type/.test(src.src));
    // The uuid/text COALESCE regression (20261018000003 as published). Any
    // uuid-returning helper mixed with a text fallback re-breaks every booking.
    check('no uuid/text COALESCE in body',
      !/resolve_customer_by_email[^)]*\)\s*,\s*'/.test(src.src) || !/coalesce\([^)]*resolve_customer_by_email/.test(src.src));
  }

  // ── FUNCTIONAL GUARD ───────────────────────────────────────────────────────
  // Presence checks above can all pass while the RPC still rejects a real
  // payload. This actually attempts a booking and asserts it SUCCEEDS, then
  // removes it. Without this, "all objects present" was reported while every
  // submit failed — which is exactly how this incident stayed hidden.
  console.log('\n── Functional guard: a real booking must succeed ──');
  const stamp = `PREREQ-GUARD-${Date.now()}`;
  const probe = await db.rpc('create_booking_atomic', {
    p_payload: {
      booking: {
        payment_status: 'unpaid',
        payment_method: 'GCash',
        customer_name: stamp,
        customer_email: 'prereq-guard@example.com',
        start_datetime: new Date(Date.now() + 7 * 864e5).toISOString(),
        end_datetime: new Date(Date.now() + 7 * 864e5 + 36e5).toISOString(),
        status: 'scheduled',
        total_amount: 250,
        vehicle_type: 'sedan',
      },
      vehicles: [{
        vehicle: { vehicle_type: 'sedan', brand: 'Guard', model: 'Guard', plate_number: stamp, status: 'SCHEDULED' },
        services: [{ service_name: 'Regular Wash', price: 250, final_price: 250, duration_minutes: 60, vehicle_type: 'sedan' }],
      }],
      payment: { amount: 250, method: 'GCash', payment_type: 'Full', status: 'FOR_VERIFICATION' },
    },
  });

  const bookingId = probe.data?.booking?.id;
  check('create_booking_atomic() accepts a real payload', Boolean(bookingId),
    probe.error ? `${probe.error.code} ${probe.error.message}` : 'no booking id returned');

  if (bookingId) {
    const { data: vehicles } = await db.from('booking_vehicles').select('id').eq('booking_id', bookingId);
    const { data: services } = await db.from('booking_vehicle_services').select('id').eq('booking_vehicle_id', vehicles?.[0]?.id || '');
    const { data: payments } = await db.from('payments').select('id').eq('booking_id', bookingId);
    check('child rows written atomically',
      (vehicles?.length || 0) === 1 && (services?.length || 0) === 1 && (payments?.length || 0) === 1,
      `vehicles=${vehicles?.length || 0} services=${services?.length || 0} payments=${payments?.length || 0}`);

    // Clean up so the guard is safe to run repeatedly.
    await db.from('bookings').delete().eq('id', bookingId);
    console.log(`  (guard booking ${bookingId} cleaned up)`);
  }

  console.log('\n════════════════════════════════════════');
  if (problems.length === 0) {
    console.log('✓ All booking prerequisites present.');
    process.exit(0);
  }
  console.log(`✗ ${problems.length} prerequisite(s) FAILED against the live database:`);
  for (const p of problems) console.log(`   • ${p}`);
  console.log('\n  → If these are missing objects, migrations are pending:');
  console.log('      npx supabase db push');
  console.log('  → If they are wrong VALUES, a migration recorded success without landing.');
  console.log('    Read the live body and fix it with a NEW migration (never edit an applied one).');
  process.exit(1);
})();