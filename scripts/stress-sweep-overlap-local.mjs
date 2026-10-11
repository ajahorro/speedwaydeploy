/**
 * Two no-show sweeps at the same time, with cancels and payment verifications landing on the same bookings.
 * Checks: no deadlock, no server error, and no booking left cancelled / no-show while a payment on it is still PAID or
 * FOR_VERIFICATION. Local scratch stack only.   node scripts/run-local-test.mjs scripts/stress-sweep-overlap-local.mjs
 */
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), SERVICE = arg('service'), BACKEND = arg('backend'), DB = arg('db');
if (!/127\.0\.0\.1|localhost/.test(API)) { console.error('Refusing to run against a non-local API.'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', q], { encoding: 'utf8' }).trim();
const signIn = async (email) => {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'LocalTest-123' }) });
  const j = await r.json(); return { token: j.access_token, id: j.user.id };
};
const rpc = async (fn, body, token) => { const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); return { status: r.status, data: t.slice(0, 200) }; };
const cancel = async (token, bookingId) => { const r = await fetch(`${BACKEND}/api/bookings/admin-cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId, reason: 'overlap' }) }); return { status: r.status, data: (await r.text()).slice(0, 200) }; };

const admin = await signIn('admin@test.local'), cust = await signIn('cust@test.local');
const N = 30, ids = [], pays = [];
const mark = new Date().toISOString();
for (let i = 0; i < N; i += 1) {
  const b = crypto.randomUUID(), p = crypto.randomUUID(), p2 = crypto.randomUUID();
  ids.push(b); pays.push(p2);
  sql(`alter table public.bookings disable trigger user; insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime) values ('${b}','${cust.id}','Sweep Overlap','confirmed','paid',500, now()-interval '3 hours', now()-interval '2 hours'); alter table public.bookings enable trigger user; insert into public.payments (id, booking_id, amount, method, payment_type, status, reference_number) values ('${p}','${b}',500,'GCash','Full','PAID','SO1${Date.now()}${i}'),('${p2}','${b}',100,'GCash','Full','FOR_VERIFICATION','SO2${Date.now()}${i}')`);
}
const jobs = [rpc('run_no_show_lifecycle', {}, SERVICE), rpc('run_no_show_lifecycle', {}, SERVICE), rpc('flag_no_show_bookings', {}, SERVICE)];
for (let i = 0; i < N; i += 3) jobs.push(cancel(admin.token, ids[i]));
for (let i = 1; i < N; i += 3) jobs.push(rpc('admin_verify_payment', { p_payment_id: pays[i], p_booking_id: ids[i], p_verified_amount: 100, p_note: 'o', p_override: false }, admin.token));
const out = await Promise.all(jobs);
const bad = out.filter((r) => r.status >= 500);
check('no server error from sweeps, cancels and verifications running together', bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 2)) : `${out.length} calls`);
const lg = spawnSync('docker', ['logs', '--since', mark, DB], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const dl = ((lg.stdout || '') + (lg.stderr || '')).match(/deadlock detected/g) || [];
check('no deadlock in the database log', dl.length === 0, `${dl.length} deadlock(s)`);
const list = ids.map((x) => `'${x}'`).join(',');
const stuck = Number(sql(`select count(*) from public.bookings b where b.id in (${list}) and upper(b.status::text) in ('CANCELLED','FLAGGED_NOSHOW') and exists (select 1 from public.payments p where p.booking_id=b.id and p.status in ('PAID','FOR_VERIFICATION'))`));
check('no cancelled / no-show booking still has a PAID or FOR_VERIFICATION payment', stuck === 0, `${stuck} booking(s)`);
const open = Number(sql(`select count(*) from public.bookings where id in (${list}) and status in ('confirmed','scheduled')`));
check('every stale booking ended up flagged or cancelled (none missed, none half-done)', open === 0, `${open} still open`);
const dupNotes = Number(sql(`select count(*) from (select user_id, booking_id, notification_type from public.notifications where booking_id in (${list}) group by 1,2,3 having count(*) > 1) d`));
check('no duplicate notifications from the two overlapping sweeps', dupNotes === 0, `${dupNotes} duplicate group(s)`);
sql(`delete from public.payments where booking_id in (${list}); delete from public.audit_logs where booking_id in (${list}); delete from public.notifications where booking_id in (${list}); delete from public.bookings where id in (${list})`);
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
