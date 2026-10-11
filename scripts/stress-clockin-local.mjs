/**
 * A technician who is not clocked in must not be able to start a service by calling the API directly.
 * Every other start rule is satisfied, so only the clock-in status changes. Local scratch stack only.
 *   node scripts/run-local-test.mjs scripts/stress-clockin-local.mjs
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), BACKEND = arg('backend'), DB = arg('db');
if (!/127\.0\.0\.1|localhost/.test(API)) { console.error('Refusing to run against a non-local API.'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', q], { encoding: 'utf8' }).trim();
const signIn = async (email) => {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'LocalTest-123' }) });
  const j = await r.json(); if (!j.access_token) throw new Error('sign-in failed ' + email); return { token: j.access_token, id: j.user.id };
};
const staff = await signIn('staff@test.local'), cust = await signIn('cust@test.local');
const wasClocked = sql(`select coalesce(is_clocked_in,false) from public.profiles where id='${staff.id}'`);

const b = crypto.randomUUID(), v = crypto.randomUUID();
sql(`alter table public.bookings disable trigger user; insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime, staff_id) values ('${b}','${cust.id}','Clock In','confirmed','paid',500, now()-interval '5 minutes', now()+interval '55 minutes','${staff.id}'); alter table public.bookings enable trigger user;
 insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, staff_id) values ('${v}','${b}','Sedan','A','B','CLK001','SCHEDULED','${staff.id}');
 insert into public.payments (booking_id, amount, method, payment_type, status, reference_number) values ('${b}',500,'CASH','Full','PAID','CLK${Date.now()}');
 insert into public.service_photos (booking_id, booking_vehicle_id, phase, storage_path, uploaded_by, source) values ('${b}','${v}','before','test/clk.jpg','${staff.id}','upload')`);

const start = async () => { const r = await fetch(`${BACKEND}/api/bookings/update-status`, { method: 'POST', headers: { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: b, unitId: v, newStatus: 'IN_PROGRESS' }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const setClock = (val) => sql(`alter table public.profiles disable trigger user; update public.profiles set is_clocked_in=${val} where id='${staff.id}'; alter table public.profiles enable trigger user`);
setClock(false);
const off = await start();
check('an off-shift technician is refused when starting a service through the API', off.status === 409 && off.body.code === 'NOT_CLOCKED_IN', `status ${off.status} ${JSON.stringify(off.body).slice(0, 100)}`);
check('and the vehicle did not start', sql(`select status from public.booking_vehicles where id='${v}'`).toUpperCase() === 'SCHEDULED');

setClock(true);
const on = await start();
check('the same technician, clocked in, can start it', on.status === 200 && on.body.success !== false, `status ${on.status} ${JSON.stringify(on.body).slice(0, 100)}`);

setClock(wasClocked === 't' ? 'true' : 'false'); sql(`delete from public.service_photos where booking_id='${b}'; delete from public.payments where booking_id='${b}'; delete from public.audit_logs where booking_id='${b}'; delete from public.notifications where booking_id='${b}'; delete from public.booking_vehicles where booking_id='${b}'; delete from public.bookings where id='${b}'`);
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
