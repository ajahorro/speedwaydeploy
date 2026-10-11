/**
 * A no-show is being refunded while the administrator presses Undo on the same booking.
 * The refund session holds the booking lock and has already written the refund; the undo arrives before it commits.
 * The booking must NOT end up reinstated with its money already returned. Local scratch stack only.
 *   node scripts/run-local-test.mjs scripts/stress-undo-race-local.mjs
 */
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), SERVICE = arg('service'), DB = arg('db');
if (!/127\.0\.0\.1|localhost/.test(API)) { console.error('Refusing to run against a non-local API.'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', q], { encoding: 'utf8' }).trim();
const custId = sql(`select id from auth.users where email='cust@test.local'`);

const b = crypto.randomUUID(), p = crypto.randomUUID();
sql(`alter table public.bookings disable trigger user; insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime) values ('${b}','${custId}','Undo Race','FLAGGED_NOSHOW','paid',500, now()-interval '2 hours', now()-interval '1 hour'); alter table public.bookings enable trigger user; insert into public.payments (id, booking_id, amount, method, payment_type, status, reference_number) values ('${p}','${b}',500,'CASH','Full','REFUND_PENDING','UR${Date.now()}')`);

const refunding = new Promise((resolve) => {
  const c = spawn('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, err }));
  c.stdin.end(`begin; set local app.refund_method='CASH'; select 1 from public.bookings where id='${b}' for update; update public.payments set status='REFUNDED' where id='${p}'; insert into public.payments (booking_id, amount, method, payment_type, status, reference_number) values ('${b}',-500,'SYSTEM_REFUND','Full','PAID','RFD-UR${Date.now()}'); select pg_sleep(2); commit;`);
});
await new Promise((r) => setTimeout(r, 800));
const r = await fetch(`${API}/rest/v1/rpc/undo_no_show`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_booking_id: b, p_actor_name: 'ADMIN', p_pending_refund: false }) });
const undo = await r.json();
const ref = await refunding;
check('the refund transaction committed', ref.code === 0, ref.err.slice(0, 120));
const status = sql(`select status from public.bookings where id='${b}'`);
const refunded = Number(sql(`select coalesce(sum(abs(amount)),0) from public.payments where booking_id='${b}' and method='SYSTEM_REFUND'`));
console.log('  undo answered:', JSON.stringify(undo).slice(0, 160), '| booking now:', status, '| refunded:', refunded);
check('a booking whose money was already refunded is NOT reinstated', !(refunded > 0 && ['scheduled', 'confirmed'].includes(status.toLowerCase())), `status ${status}, refunded ${refunded}`);
sql(`delete from public.payments where booking_id='${b}'; delete from public.audit_logs where booking_id='${b}'; delete from public.notifications where booking_id='${b}'; delete from public.bookings where id='${b}'`);
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
