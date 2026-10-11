/**
 * Hostile probes the other local suites do not cover: forged tokens, conflicting parallel transitions on one booking,
 * absurd numbers, and a database-wide money-consistency sweep. Local scratch stack only.
 *   node scripts/run-local-test.mjs scripts/stress-hostile-local.mjs
 */
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), SERVICE = arg('service'), BACKEND = arg('backend'), DB = arg('db');
if (!/127\.0\.0\.1|localhost/.test(API)) { console.error('Refusing to run against a non-local API.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', q], { encoding: 'utf8' }).trim();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const hs = (payload, secret, alg = 'HS256') => { const d = `${b64({ alg, typ: 'JWT' })}.${b64(payload)}`; return `${d}.${crypto.createHmac('sha256', secret).update(d).digest('base64url')}`; };

const signIn = async (email) => {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'LocalTest-123' }) });
  const j = await r.json(); if (!j.access_token) throw new Error(`sign-in failed for ${email}`);
  return { token: j.access_token, id: j.user.id };
};
const rpc = async (fn, body, token) => {
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token || ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { ok: r.ok, status: r.status, data: d };
};
const rest = async (path, token, opts = {}) => fetch(`${API}/rest/v1/${path}`, { ...opts, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const backend = (path, token, opts = {}) => fetch(`${BACKEND}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });

const admin = await signIn('admin@test.local');
const cust = await signIn('cust@test.local');
console.log('\n=== 1. Forged and tampered tokens');
const adminPath = '/api/admin/profiles';
const real = await backend(adminPath, admin.token);
check('control: the real admin token works on an admin route', real.status === 200, `status ${real.status}`);
const asCust = await backend(adminPath, cust.token);
check('a real customer token is refused on an admin route', asCust.status === 403 || asCust.status === 401, `status ${asCust.status}`);
const forgedPayload = { sub: cust.id, role: 'authenticated', aud: 'authenticated', exp: 1983812996, user_role: 'ADMIN', app_metadata: { role: 'ADMIN' } };
for (const [label, tok] of [
  ['signed with a wrong secret', hs(forgedPayload, 'not-the-real-secret-not-the-real-secret')],
  ['alg "none" with no signature', `${b64({ alg: 'none', typ: 'JWT' })}.${b64(forgedPayload)}.`],
  ['a real customer token with the payload swapped to the admin id', `${cust.token.split('.')[0]}.${b64({ ...forgedPayload, sub: admin.id })}.${cust.token.split('.')[2]}`],
  ['an expired token', hs({ ...forgedPayload, exp: 1000000000 }, 'super-secret-jwt-token-with-at-least-32-characters-long')],
  ['garbage', 'a.b.c']
]) {
  const viaApi = await backend(adminPath, tok);
  const viaRest = await rest('profiles?select=id&limit=5', tok);
  check(`${label}: backend admin route refuses`, [401, 403].includes(viaApi.status), `status ${viaApi.status}`);
  check(`${label}: database REST refuses`, viaRest.status === 401 || viaRest.status === 403, `status ${viaRest.status}`);
}
const bodyRole = await backend(adminPath, cust.token, { method: 'POST', body: JSON.stringify({ role: 'ADMIN', userId: admin.id }) });
check('a customer sending role=ADMIN / an admin userId in the body gains nothing', [401, 403, 404, 405].includes(bodyRole.status), `status ${bodyRole.status}`);
const selfPromote = await rest(`profiles?id=eq.${cust.id}`, cust.token, { method: 'PATCH', body: JSON.stringify({ role: 'ADMIN', can_view_reports: true, is_active: true }), headers: { Prefer: 'return=representation' } });
const roleNow = sql(`select role from public.profiles where id='${cust.id}'`);
check('a customer PATCHing their own role to ADMIN is refused or ignored', roleNow.toUpperCase() !== 'ADMIN', `role now ${roleNow}, status ${selfPromote.status}`);

console.log('\n=== 2. Conflicting parallel transitions on one booking');
const bid = crypto.randomUUID();
const vid = crypto.randomUUID();
const pay = crypto.randomUUID();
sql(`alter table public.bookings disable trigger user; insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime) values ('${bid}','${cust.id}','Hostile Race','scheduled','pending',1000, now()+interval '2 days', now()+interval '2 days 1 hour'); alter table public.bookings enable trigger user;`);
sql(`insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status) values ('${vid}','${bid}','Sedan','A','B','HOSTILE1','SCHEDULED'); insert into public.payments (id, booking_id, amount, method, payment_type, status, reference_number) values ('${pay}','${bid}',1000,'GCash','Full','FOR_VERIFICATION','HOSTILEREF${Date.now()}')`);
const adminProfile = sql(`select coalesce(nullif(first_name,''),'Admin') from public.profiles where id='${admin.id}'`);
const ops = [];
for (let i = 0; i < 6; i += 1) ops.push(rpc('admin_verify_payment', { p_payment_id: pay, p_booking_id: bid, p_verified_amount: 1000, p_note: 'race', p_override: false }, admin.token));
for (let i = 0; i < 6; i += 1) ops.push(backend('/api/bookings/admin-cancel', admin.token, { method: 'POST', body: JSON.stringify({ bookingId: bid, reason: 'race' }) }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.text() })));
const res = await Promise.all(ops);
console.log('  statuses:', JSON.stringify(res.map((r) => r.status)), res.slice(6).map((r) => String(r.data).slice(0, 60)).join(' | '));
const direct = await rpc('admin_cancel_booking', { p_booking_id: bid, p_reason: 'x', p_actor_id: admin.id, p_actor_name: adminProfile, p_actor_role: 'ADMIN' }, admin.token);
check('the cancel function cannot be called directly by a signed-in admin (backend only)', direct.status === 403 || direct.status === 401, `status ${direct.status}`);
res.forEach((r, i) => { if (r.status >= 500) console.log('  5XX BODY', i, JSON.stringify(r.data).slice(0, 600)); });
check('no parallel verify/cancel produced a server error (5xx)', res.every((r) => r.status < 500), JSON.stringify(res.map((r) => r.status)));
const refundRows = Number(sql(`select count(*) from public.payments where booking_id='${bid}' and method='SYSTEM_REFUND'`));
const refundSum = Number(sql(`select coalesce(sum(abs(amount)),0) from public.payments where booking_id='${bid}' and method='SYSTEM_REFUND'`));
const finalStatus = sql(`select status from public.bookings where id='${bid}'`);
const paidSum = Number(sql(`select coalesce(sum(amount),0) from public.payments where booking_id='${bid}' and amount>0`));
check('the booking ended in exactly one coherent state', ['cancelled', 'CANCELLED', 'scheduled', 'confirmed'].includes(finalStatus), finalStatus);
check('money was never refunded more than once, nor more than was paid', refundSum <= paidSum && refundRows <= 1, `${refundRows} refund row(s), refunded ${refundSum} of ${paidSum}`);
const led = JSON.parse(sql(`select row_to_json(l) from public.booking_ledger_v l where booking_id='${bid}'`) || '{}');
check('the ledger for that booking is internally consistent', Number(led.net_settled) >= 0 && Number(led.outstanding_amount) >= 0 && Number(led.excess_amount) >= 0, JSON.stringify({ n: led.net_settled, o: led.outstanding_amount, e: led.excess_amount }));

console.log('\n=== 2b. The verify/reject-versus-cancel race, repeated on fresh bookings');
const ROUNDS = Number(process.env.HOSTILE_ROUNDS || 60);
const since = new Date().toISOString();
let serverErrors = 0, incoherent = 0, doubleRefund = 0;
const roundIds = [];
for (let n = 0; n < ROUNDS; n += 1) {
  const b = crypto.randomUUID(), p1 = crypto.randomUUID(), p2 = crypto.randomUUID();
  roundIds.push(b);
  sql(`alter table public.bookings disable trigger user; insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime) values ('${b}','${cust.id}','Hostile Round','scheduled','pending',1000, now()+interval '2 days', now()+interval '2 days 1 hour'); alter table public.bookings enable trigger user; insert into public.payments (id, booking_id, amount, method, payment_type, status, reference_number) values ('${p1}','${b}',500,'GCash','Full','FOR_VERIFICATION','HR1${Date.now()}${n}'),('${p2}','${b}',500,'GCash','Full','FOR_VERIFICATION','HR2${Date.now()}${n}')`);
  const jobs = [];
  for (let i = 0; i < 3; i += 1) jobs.push(rpc('admin_verify_payment', { p_payment_id: p1, p_booking_id: b, p_verified_amount: 500, p_note: 'r', p_override: false }, admin.token));
  for (let i = 0; i < 3; i += 1) jobs.push(rpc('admin_reject_payment', { p_payment_id: p2, p_booking_id: b, p_reason: 'r', p_queue_refund: false, p_refund_note: null }, admin.token));
  for (let i = 0; i < 4; i += 1) jobs.push(backend('/api/bookings/admin-cancel', admin.token, { method: 'POST', body: JSON.stringify({ bookingId: b, reason: 'race' }) }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.text() })));
  const out = await Promise.all(jobs);
  if (out.some((r) => r.status >= 500)) { serverErrors += 1; console.log('  5XX in round', n, JSON.stringify(out.map((r) => r.status)), out.filter((r) => r.status >= 500).map((r) => String(JSON.stringify(r.data)).slice(0, 160)).join(' | ')); }
  const st = sql(`select status from public.bookings where id='${b}'`);
  if (!['CANCELLED', 'scheduled', 'confirmed'].includes(st)) incoherent += 1;
  const refunds = Number(sql(`select coalesce(sum(abs(amount)),0) from public.payments where booking_id='${b}' and method='SYSTEM_REFUND'`));
  const paid = Number(sql(`select coalesce(sum(amount),0) from public.payments where booking_id='${b}' and amount>0 and status in ('PAID','REFUND_PENDING','REFUNDED')`));
  if (refunds > paid + 0.005) doubleRefund += 1;
}
check(`${ROUNDS} rounds of verify + reject + cancel in parallel: no server error (5xx)`, serverErrors === 0, `${serverErrors} round(s) with a 5xx`);
check('and every round ended in a coherent booking state', incoherent === 0, `${incoherent} incoherent`);
check('and no round refunded more than it received', doubleRefund === 0, `${doubleRefund} over-refunded`);
const lg = spawnSync('docker', ['logs', '--since', since, DB], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); const deadlocks = (lg.stdout || '') + (lg.stderr || '');
const deadlockCount = (deadlocks.match(/deadlock detected/g) || []).length;
check('the database logged no deadlock during those rounds', deadlockCount === 0, `${deadlockCount} deadlock(s)`);
sql(`delete from public.payments where booking_id in (${roundIds.map((x) => `'${x}'`).join(',')}); delete from public.notifications where booking_id in (${roundIds.map((x) => `'${x}'`).join(',')}); delete from public.audit_logs where booking_id in (${roundIds.map((x) => `'${x}'`).join(',')}); delete from public.booking_vehicles where booking_id in (${roundIds.map((x) => `'${x}'`).join(',')}); delete from public.bookings where id in (${roundIds.map((x) => `'${x}'`).join(',')})`);

console.log('\n=== 2c. Deterministic lock-order test: a cancel holds the booking lock, a verify / reject arrives meanwhile');
// The cancel is simulated in its own database session with the same lock order as admin_cancel_booking (booking row first,
// then its payments) and a 2 second pause between the two steps, so the verify / reject is certain to arrive in the middle.
const { spawn } = await import('node:child_process');
for (const [label, call] of [
  ['verify', (b, p) => rpc('admin_verify_payment', { p_payment_id: p, p_booking_id: b, p_verified_amount: 500, p_note: 'd', p_override: false }, admin.token)],
  ['reject', (b, p) => rpc('admin_reject_payment', { p_payment_id: p, p_booking_id: b, p_reason: 'd', p_queue_refund: false, p_refund_note: null }, admin.token)]
]) {
  const b = crypto.randomUUID(), p = crypto.randomUUID();
  sql(`alter table public.bookings disable trigger user; insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime) values ('${b}','${cust.id}','Hostile Det','scheduled','pending',500, now()+interval '2 days', now()+interval '2 days 1 hour'); alter table public.bookings enable trigger user; insert into public.payments (id, booking_id, amount, method, payment_type, status, reference_number) values ('${p}','${b}',500,'GCash','Full','FOR_VERIFICATION','HD${Date.now()}${label}')`);
  const mark = new Date().toISOString();
  const cancelLike = new Promise((resolve) => {
    const c = spawn('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, err }));
    c.stdin.end(`begin; select 1 from public.bookings where id='${b}' for update; select pg_sleep(2); update public.payments set status='REFUND_PENDING' where booking_id='${b}' and status in ('PAID','FOR_VERIFICATION'); commit;`);
  });
  await new Promise((r) => setTimeout(r, 800));
  const other = await call(b, p);
  const cancelRes = await cancelLike;
  const lg2 = spawnSync('docker', ['logs', '--since', mark, DB], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const dl = ((lg2.stdout || '') + (lg2.stderr || '')).match(/deadlock detected/g) || [];
  check(`${label} arriving while a cancel holds the booking: answered without a server error`, other.status < 500, `status ${other.status} ${String(JSON.stringify(other.data)).slice(0, 90)}`);
  check(`${label} arriving while a cancel holds the booking: the cancel itself completed`, cancelRes.code === 0, cancelRes.err.slice(0, 100));
  check(`${label} arriving while a cancel holds the booking: no deadlock in the database log`, dl.length === 0, `${dl.length} deadlock(s)`);
  sql(`delete from public.payments where booking_id='${b}'; delete from public.audit_logs where booking_id='${b}'; delete from public.notifications where booking_id='${b}'; delete from public.bookings where id='${b}'`);
}

console.log('\n=== 3. Absurd numbers in money paths');
const bad = [-1, 0, 1e15, 1e308, 0.001, 'NaN', 'Infinity', '1; drop table payments'];
for (const v of bad) {
  const r = await rpc('process_booking_refund_v2', { p_booking_id: bid, p_refund_amount: v, p_refund_reason: 'x', p_refund_reference: `RFD-HOSTILE-${Math.random().toString(36).slice(2, 8)}`, p_refund_deduction: 0, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token);
  check(`refund amount ${JSON.stringify(v)} is refused and does not crash`, !r.ok && r.status < 500, `status ${r.status} ${String(JSON.stringify(r.data)).slice(0, 70)}`);
}
check('payments table still exists and holds no rounding fractions beyond 2 places', Number(sql(`select count(*) from public.payments where amount <> round(amount,2)`)) === 0);
const customerBadPay = await rest('payments', cust.token, { method: 'POST', body: JSON.stringify({ booking_id: bid, amount: -500, method: 'Cash', payment_type: 'Full', status: 'PAID' }) });
check('a customer cannot insert a negative or PAID payment', !customerBadPay.ok, `status ${customerBadPay.status}`);

console.log('\n=== 4. Database-wide money consistency sweep');
const inv = (name, q) => { const n = Number(sql(q)); check(name, n === 0, n ? `${n} violating booking(s)` : ''); };
inv('no booking shows a negative outstanding, excess or net settled', `select count(*) from public.booking_ledger_v where outstanding_amount < 0 or excess_amount < 0 or net_settled < 0`);
inv('no booking is both owing and in excess', `select count(*) from public.booking_ledger_v where outstanding_amount > 0 and excess_amount > 0`);
inv('no cancelled / no-show booking reports an outstanding balance', `select count(*) from public.booking_ledger_v l join public.bookings b on b.id=l.booking_id where upper(b.status::text) in ('CANCELLED','FLAGGED_NOSHOW','NO_SHOW') and l.outstanding_amount > 0`);
inv('no booking has refunded more than it ever received', `select count(*) from public.booking_ledger_v where refunded_amount > settled_amount + 0.005`);
inv('no money amount has more than 2 decimal places', `select count(*) from public.payments where amount <> round(amount,2)`);
inv('no payment reference is used twice', `select count(*) from (select reference_number from public.payments where reference_number is not null and reference_number <> '' and method <> 'SYSTEM_REFUND' group by 1 having count(*) > 1) d`);

sql(`delete from public.payments where booking_id='${bid}'; delete from public.booking_vehicles where booking_id='${bid}'; delete from public.notifications where booking_id='${bid}'; delete from public.bookings where id='${bid}'`);
console.log(`\n${pass}/${pass + fail} hostile checks passed`);
process.exit(fail ? 1 : 0);
