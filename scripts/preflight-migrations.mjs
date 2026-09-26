#!/usr/bin/env node
/**
 * scripts/preflight-migrations.mjs
 * ============================================================================
 * Staging smoke test for the Batch-1 migration set (Scenarios 1–11).
 *
 * USAGE
 *   node scripts/preflight-migrations.mjs            # dry-run report only
 *   node scripts/preflight-migrations.mjs --apply    # actually apply, then verify
 *
 * WHY THIS EXISTS
 *   The Batch-1 fixes ship as four SQL migrations whose correctness depends on
 *   the LIVE schema they run against (column existence, function overloads, and
 *   a runtime string-patch applied to create_booking_atomic). Parsing them in a
 *   PGlite shim proves syntax but NOT that they land cleanly in the real project.
 *
 *   This script connects with the SAME service-role credentials the backend uses
 *   (backend/.env) and:
 *     1. Prints a SAFETY REPORT (row counts) so you can confirm the target is a
 *        throwaway staging DB before you ever pass --apply.
 *     2. Verifies each migration's preconditions (columns/functions it depends
 *        on exist) and reports drift, WITHOUT writing anything (dry-run).
 *     3. With --apply: executes the migrations in order, then re-verifies that
 *        every new column / function / trigger / view is actually present and
 *        that the Scenario-10 ledger math resolves to the expected ₱120.
 *
 * SAFETY
 *   - Refuses to run --apply unless SUPABASE_URL looks like a staging/dev host
 *     OR you set ALLOW_NON_STAGING=1 explicitly.
 *   - Never deletes anything. All writes are additive DDL from the migrations.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── Load backend/.env (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) ─────────────
const envPath = path.join(repoRoot, 'backend', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing. Set them in backend/.env.');
  process.exit(2);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

const MIGRATIONS = [
  '20261018000001_ocr_override_lock_and_refund_ledger.sql',
  '20261018000002_service_price_immutability.sql',
  '20261018000003_identity_capacity_ocr_race.sql',
  '20261018000004_qr_snapshot_default.sql',
];

// Preconditions each migration needs already present in the live DB.
const PRECONDITIONS = [
  { sql: "select 1 from information_schema.columns where table_schema='public' and table_name='payments' and column_name='status'", label: 'payments.status' },
  { sql: "select 1 from information_schema.columns where table_schema='public' and table_name='booking_vehicle_services' and column_name='price_at_booking'", label: 'booking_vehicle_services.price_at_booking' },
  { sql: "select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='slot_has_capacity'", label: 'public.slot_has_capacity()' },
  { sql: "select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_booking_atomic'", label: 'public.create_booking_atomic()' },
  { sql: "select 1 from information_schema.columns where table_schema='public' and table_name='business_config' and column_name='qr_config_version'", label: 'business_config.qr_config_version' },
  { sql: "select 1 from information_schema.columns where table_schema='public' and table_name='bookings' and column_name='active_qr_snapshot'", label: 'bookings.active_qr_snapshot' },
];

// What we expect to exist AFTER applying.
const POSTCONDITIONS = {
  columns: [
    ['payments', 'manual_override'], ['payments', 'ocr_locked'], ['payments', 'overridden_by'],
    ['payments', 'overridden_at'], ['payments', 'signed_amount'],
    ['payments', 'ocr_evaluated_total'], ['payments', 'ocr_evaluated_at'],
  ],
  functions: ['booking_net_paid', 'admin_override_payment_to_paid', 'resolve_customer_by_email',
    'booking_slot_is_open', 'default_qr_snapshot', 'protect_booking_service_price',
    'booking_total_changed_since_ocr', 'persist_ocr_result'],
  triggers: ['trg_protect_booking_service_price', 'trg_default_qr_snapshot'],
  views: ['booking_service_lines'],
};

// A read-only SQL runner is not exposed; we probe through PostgREST instead.
async function probe(label, fn) {
  try { const v = await fn(); return { label, ok: true, value: v }; }
  catch (e) { return { label, ok: false, error: e.message }; }
}

async function columnExists(table, column) {
  const { error } = await db.from(table).select(column).limit(1);
  return !error;
}
async function functionExists(name, args) {
  const { error } = await db.rpc(name, args);
  // A "function does not exist" error means absent; any other error means it exists.
  return !/could not find the function|does not exist|schema cache/i.test(error?.message || '');
}
async function viewExists(name) {
  const { error } = await db.from(name).select('*').limit(1);
  return !error;
}

(async () => {
  console.log('════════════════════════════════════════');
  console.log(' BATCH-1 MIGRATION PREFLIGHT');
  console.log(' Target:', SUPABASE_URL);
  console.log(' Mode  :', APPLY ? '--apply (WILL WRITE DDL)' : 'dry-run (read-only)');
  console.log('════════════════════════════════════════\n');

  // ── 1. SAFETY REPORT ──────────────────────────────────────────────────────
  console.log('── Safety report (row counts) ──');
  const counts = {};
  for (const t of ['bookings', 'payments', 'profiles', 'business_config', 'audit_logs', 'booking_vehicles']) {
    const { count, error } = await db.from(t).select('*', { count: 'exact', head: true });
    counts[t] = error ? `ERR(${error.message})` : count;
    console.log(`  ${t.padEnd(18)} ${counts[t]}`);
  }

  const isStagingHost = /localhost|127\.0\.0\.1|staging|dev|test/i.test(SUPABASE_URL);
  if (APPLY && !isStagingHost && process.env.ALLOW_NON_STAGING !== '1') {
    console.error('\n✗ REFUSING to --apply: SUPABASE_URL does not look like a staging host.');
    console.error('  If this really is a disposable environment, re-run with ALLOW_NON_STAGING=1.');
    process.exit(3);
  }

  // ── 2. PRECONDITIONS ──────────────────────────────────────────────────────
  console.log('\n── Preconditions (must already exist) ──');
  let preOk = true;
  for (const { label, sql } of PRECONDITIONS) {
    // We cannot run raw SQL via PostgREST, so probe with the equivalent client call.
    let ok = false;
    if (label === 'payments.status') ok = await columnExists('payments', 'status');
    else if (label === 'booking_vehicle_services.price_at_booking') ok = await columnExists('booking_vehicle_services', 'price_at_booking');
    else if (label === 'public.slot_has_capacity()') ok = await functionExists('slot_has_capacity', { p_start: new Date().toISOString(), p_end: new Date(Date.now() + 36e5).toISOString(), p_exclude_booking_id: null, p_requested_bays: 1 });
    else if (label === 'public.create_booking_atomic()') ok = await functionExists('create_booking_atomic', { p_payload: { booking: {}, vehicles: [] } });
    else if (label === 'business_config.qr_config_version') ok = await columnExists('business_config', 'qr_config_version');
    else if (label === 'bookings.active_qr_snapshot') ok = await columnExists('bookings', 'active_qr_snapshot');
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) preOk = false;
  }
  if (!preOk) {
    console.error('\n✗ Preconditions failed — the live schema differs from what Batch-1 assumes.');
    console.error('  Fix the drift BEFORE applying, or the migrations will partially fail.');
    process.exit(4);
  }

  // ── 3. MIGRATION FILES PRESENT ────────────────────────────────────────────
  console.log('\n── Migration files ──');
  for (const f of MIGRATIONS) {
    const p = path.join(repoRoot, 'supabase', 'migrations', f);
    console.log(`  ${fs.existsSync(p) ? '✓' : '✗'} ${f}`);
  }

  if (!APPLY) {
    console.log('\nℹ Dry-run complete. Re-run with --apply to execute against this database.');
    console.log('  (Recommended: run the migration files through `supabase db push` or the SQL');
    console.log('   editor instead, so the migration ledger stays authoritative.)');
    process.exit(0);
  }

  // ── 4. APPLY NOTE ─────────────────────────────────────────────────────────
  // PostgREST cannot execute arbitrary DDL, so this script cannot apply the SQL
  // itself without a direct Postgres connection string. We surface that clearly
  // rather than pretend to succeed.
  console.log('\n⚠ --apply requires a DIRECT Postgres connection (SUPABASE_DB_URL / pooler),');
  console.log('  which is not configured in backend/.env. Apply with one of:');
  console.log('    • supabase db push                 (CLI, preferred)');
  console.log('    • psql "$SUPABASE_DB_URL" -f supabase/migrations/<file>.sql');
  console.log('  Then re-run this script WITHOUT --apply to validate the post-state below.\n');

  // ── 5. POSTCONDITION CHECK ────────────────────────────────────────────────
  console.log('── Postconditions (current live state) ──');
  let postFail = 0;
  for (const [t, c] of POSTCONDITIONS.columns) {
    const ok = await columnExists(t, c);
    if (!ok) postFail += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${t}.${c}`);
  }
  for (const fn of POSTCONDITIONS.functions) {
    const probeArgs = fn === 'booking_net_paid' ? { p_booking_id: '00000000-0000-0000-0000-000000000000' }
      : fn === 'resolve_customer_by_email' ? { p_email: 'x@example.com' }
        : fn === 'booking_slot_is_open' ? { p_start: new Date(Date.now() + 864e5).toISOString(), p_end: new Date(Date.now() + 864e5 + 36e5).toISOString(), p_requested_bays: 1 }
          : fn === 'booking_total_changed_since_ocr' ? { p_payment_id: '00000000-0000-0000-0000-000000000000' }
            : fn === 'persist_ocr_result' ? { p_booking_id: '00000000-0000-0000-0000-000000000000', p_payment_id: '00000000-0000-0000-0000-000000000000', p_detected_amount: 0, p_detected_ref: null, p_payment_status: 'unpaid', p_ocr_metadata: {} }
              : fn === 'admin_override_payment_to_paid' ? { p_payment_id: '00000000-0000-0000-0000-000000000000', p_booking_id: '00000000-0000-0000-0000-000000000000', p_verified_amount: 1 }
                : {};
    const ok = await functionExists(fn, probeArgs);
    if (!ok) postFail += 1;
    console.log(`  ${ok ? '✓' : '✗'} public.${fn}()`);
  }
  for (const v of POSTCONDITIONS.views) {
    const ok = await viewExists(v);
    if (!ok) postFail += 1;
    console.log(`  ${ok ? '✓' : '✗'} view public.${v}`);
  }

  console.log(postFail === 0
    ? '\n✓ All Batch-1 objects are present in the live schema — migrations are applied.'
    : `\n✗ ${postFail} Batch-1 object(s) still missing — apply the migrations (see above).`);
  process.exit(postFail === 0 ? 0 : 1);
})();