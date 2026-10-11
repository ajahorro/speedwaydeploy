/**
 * Lock-order test. Cancel locks the booking first and its payments second. Any function that takes them in the other order
 * can deadlock with a cancel. For each function, a cancel-like session holds the booking lock for 2 seconds and then touches
 * the payments, and the function under test is fired in the middle of that window. Local scratch stack only.
 *   node scripts/run-local-test.mjs scripts/stress-lockorder-local.mjs
 */
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), SERVICE = arg('service'), DB = arg('db');
if (!/127\.0\.0\.1|localhost/.test(API)) { console.error('Refusing to run against a non-local API.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', q], { encoding: 'utf8' }).trim();
const signIn = async (email) => {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'LocalTest-123' }) });
  const j = await r.json(); if (!j.access_token) throw new Error(`sign-in failed for ${email}`); return { token: j.access_token, id: j.user.id };
};
const rpc = async (fn, body, token) => {
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { ok: r.ok, status: r.status, data: d };
};
const admin = await signIn('admin@test.local');
const cust = await signIn('cust@test.local');

const makeBooking = (b, p, { method = 'GCash', status = 'FOR_VERIFICATION', amount = 500 } = {}) => sql(
  `alter table public.bookings disable trigger user; insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime) values ('${b}','${cust.id}','Lock Order','scheduled','pending',500, now()+interval '2 days', now()+interval '2 days 1 hour'); alter table public.bookings enable trigger user; insert into public.payments (id, booking_id, amount, method, payment_type, status, reference_number) values ('${p}','${b}',${amount},'${method}','Full','${status}','LO${Date.now()}${Math.floor(Math.random() * 1e6)}')`);
const cleanup = (b) => sql(`delete from public.payments where booking_id='${b}'; delete from public.audit_logs where booking_id='${b}'; delete from public.notifications where booking_id='${b}'; delete from public.bookings where id='${b}'`);

const cancelLike = (b) => new Promise((resolve) => {
  const c = spawn('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, err }));
  c.stdin.end(`begin; select 1 from public.bookings where id='${b}' for update; select pg_sleep(2); update public.payments set updated_at = now() where booking_id='${b}'; commit;`);
});

async function lockCase(label, method, status, call) {
  const b = crypto.randomUUID(), p = crypto.randomUUID();
  makeBooking(b, p, { method, status });
  const mark = new Date().toISOString();
  const held = cancelLike(b);
  await new Promise((r) => setTimeout(r, 800));
  const other = await call(b, p);
  const done = await held;
  const lg = spawnSync('docker', ['logs', '--since', mark, DB], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const dl = ((lg.stdout || '') + (lg.stderr || '')).match(/deadlock detected/g) || [];
  check(`${label}: no deadlock while a cancel holds the booking`, dl.length === 0 && done.code === 0, `${dl.length} deadlock(s)${done.err ? ' — ' + done.err.slice(0, 80) : ''}`);
  check(`${label}: answered without a server error`, other.status < 500, `status ${other.status} ${String(JSON.stringify(other.data)).slice(0, 90)}`);
  cleanup(b);
}

console.log('\n=== Lock order against a cancel');
await lockCase('persist_ocr_result (after a receipt upload)', 'GCash', 'FOR_VERIFICATION',
  (b, p) => rpc('persist_ocr_result', { p_booking_id: b, p_payment_id: p, p_detected_amount: 500, p_detected_ref: 'LOREF1', p_payment_status: 'for_verification', p_ocr_metadata: { test: true } }, SERVICE));
await lockCase('admin_cancel_receivable', 'RECEIVABLE', 'PENDING',
  (b, p) => rpc('admin_cancel_receivable', { p_payment_id: p }, admin.token));

console.log(`\n${pass}/${pass + fail} lock-order checks passed`);
process.exit(fail ? 1 : 0);
