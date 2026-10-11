/**
 * All-tiers probe for the LOCAL scratch stack only (never production): signed-out visitor, two customers, two staff,
 * administrator. It tries to do what each tier must NOT be able to do (read other people's data, write what only the
 * server or an administrator may write, call admin functions and routes), what only the right tier should be able to
 * do, and what goes wrong when many things happen at once or with hostile input.
 *
 *   node scripts/stress-tiers-local.mjs --api http://127.0.0.1:55421 --anon <key> --service <key> --backend http://127.0.0.1:3999 --db supabase_db_speedway-ledger-test
 *
 * Every line is a check: PASS = the system behaved as it should; FAIL = a finding (something allowed that should not
 * be, or a failure that should not happen). Everything created is tagged TIERS and removed again.
 */
import { execFileSync } from 'node:child_process';
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), SERVICE = arg('service'), BACKEND = arg('backend') || 'http://127.0.0.1:3999';
const DB = arg('db') || 'supabase_db_speedway-ledger-test';
if (!API || !ANON || !SERVICE) { console.error('Missing --api / --anon / --service'); process.exit(2); }
for (const url of [API, BACKEND]) if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) { console.error('Refusing non-local host'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };
const note = (text) => console.log(`      ${text}`);
const section = (text) => console.log(`\n=== ${text}`);
const sql = (statement) => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', statement], { encoding: 'utf8' }).trim();
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const PASSWORD = 'LocalTest-123';
const login = async (email) => {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return { token: j.access_token, id: j.user.id, email };
};
const rest = (path, { token = SERVICE, method = 'GET', body, headers = {} } = {}) =>
  fetch(`${API}/rest/v1/${path}`, { method, headers: { apikey: token === SERVICE ? SERVICE : ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const rpc = async (fn, args, token) => { const r = await rest(`rpc/${fn}`, { token, method: 'POST', body: args }); return { ok: r.ok, status: r.status, data: await json(r) }; };
const api = async (path, { token, method = 'POST', body, raw } = {}) => {
  const r = await fetch(`${BACKEND}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined) });
  return { ok: r.ok, status: r.status, data: await json(r) };
};
const msg = (r) => String(r.data?.message || r.data?.error || (typeof r.data === 'string' ? r.data.slice(0, 80) : JSON.stringify(r.data))).slice(0, 100);
const rows = (r) => (Array.isArray(r.data) ? r.data : []);
const get = async (table, query, token) => { const r = await rest(`${table}?${query}`, { token }); return { ok: r.ok, status: r.status, data: await json(r) }; };
const ANONT = ANON; // the signed-out visitor sends the public key as its bearer

// ---- people and data -------------------------------------------------------------------------------------------
const admin = await login('admin@test.local');
const A = await login('cust@test.local');
const B = await login('soa-customer@test.local');
const staff = await login('staff@test.local');
const staff2 = await login('real-staff@test.local');
const tag = Date.now().toString().slice(-6);

const mkBooking = (id, customer, { status = 'confirmed', total = 500, days = 2, paid = 500 } = {}) => {
  sql(`set session_replication_role = replica; insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime, notes) values ('${id}', '${customer}', 'Tiers Test', '${status}', 'paid', ${total}, now() + interval '${days} days', now() + interval '${days} days 1 hour', 'TIERS ${tag}');`);
  if (paid > 0) sql(`insert into public.payments (booking_id, amount, method, payment_type, status, reference_number) values ('${id}', ${paid}, 'GCash', 'Full', 'PAID', 'TIERS${tag}${id.slice(-4)}')`);
};
const bA = `9a000000-0000-0000-0000-0000000a${tag.slice(0, 4)}`.slice(0, 36);
const ids = { A: '9a000000-0000-0000-0000-00000000a001', B: '9a000000-0000-0000-0000-00000000b001', Bdone: '9a000000-0000-0000-0000-00000000b002' };
void bA;
const cleanup = () => {
  const list = Object.values(ids).map((i) => `'${i}'`).join(',');
  try {
    sql(`set session_replication_role = replica; delete from public.payments where booking_id in (${list}); delete from public.customer_credit_ledger where booking_id in (${list}); delete from public.audit_logs where booking_id in (${list}); delete from public.notifications where booking_id in (${list}); delete from public.booking_vehicles where booking_id in (${list}); delete from public.bookings where id in (${list}); delete from public.promo_codes where code like 'TIERS%'; delete from public.guest_inquiries where email like 'tiers-%'; delete from public.notifications where title like 'TIERS%';`);
  } catch (error) { console.log('cleanup:', String(error.message).split('\n')[0]); }
};
cleanup();
mkBooking(ids.A, A.id);
mkBooking(ids.B, B.id);
mkBooking(ids.Bdone, B.id, { status: 'completed', total: 500, paid: 800 }); // completed with a ₱300 excess
sql(`set session_replication_role = replica; insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status) values ('9a000000-0000-0000-0000-00000000a0e1', '${ids.A}', 'Sedan', 'T', 'T', 'TIER1', 'SCHEDULED'), ('9a000000-0000-0000-0000-00000000b0e1', '${ids.B}', 'Sedan', 'T', 'T', 'TIER2', 'SCHEDULED');`);
const payB = sql(`select id from public.payments where booking_id='${ids.B}' limit 1`);
const payA = sql(`select id from public.payments where booking_id='${ids.A}' limit 1`);
const state = (q) => sql(q);

// =====================================================================================================================
section('1. The signed-out visitor');
const PRIVATE = ['profiles', 'bookings', 'payments', 'audit_logs', 'notifications', 'booking_messages', 'customer_credit_ledger', 'service_photos', 'vehicles', 'invites', 'pending_registrations', 'account_recovery_otps', 'qr_change_otp', 'ocr_scan_sessions', 'password_confirmation_requests', 'login_security_notices', 'booking_email_deliveries', 'refund_proofs', 'guest_inquiries', 'guest_inquiry_messages', 'staff_attendance', 'booking_vehicles', 'booking_vehicle_services', 'fleet_groups', 'booking_events', 'user_broadcast_reads', 'booking_ledger_v', 'payment_ledger_v', 'booking_service_lines'];
for (const table of PRIVATE) {
  const real = Number(sql(`select count(*) from public.${table}`));
  const r = await get(table, 'select=*&limit=5', ANONT);
  const seen = rows(r).length;
  check(`signed-out visitor cannot read ${table}`, seen === 0, real === 0 ? 'table is empty here' : `sees ${seen} of ${real} rows${r.ok ? '' : ' (error ' + r.status + ')'}`);
}
const config = await get('business_config', 'select=*&limit=1', ANONT);
check('the visitor can read the public shop settings (needed for booking)', rows(config).length === 1);
const cfgKeys = Object.keys(rows(config)[0] || {});
note(`public shop settings expose: ${cfgKeys.filter((k) => /key|secret|token|password|smtp|api/i.test(k)).join(', ') || 'no secret-looking columns'}`);
check('no secret-looking column is in the public shop settings', !cfgKeys.some((k) => /secret|token|password|smtp|api_key|private/i.test(k)));

const anonWrites = [
  ['notifications', { user_id: A.id, title: 'TIERS phish', message: 'x', notification_type: 'SYSTEM' }],
  ['payments', { booking_id: ids.A, amount: 1, method: 'Cash', status: 'PAID', payment_type: 'Full' }],
  ['bookings', { customer_name: 'x', status: 'confirmed', total_amount: 0, start_datetime: new Date().toISOString(), end_datetime: new Date().toISOString() }],
  ['profiles', { id: crypto.randomUUID(), email: 'tiers-x@test.local', role: 'ADMIN' }],
  ['audit_logs', { action_type: 'TIERS_FORGED', details: 'forged' }],
  ['booking_messages', { booking_id: ids.A, message: 'TIERS spoof' }],
  ['promo_codes', { code: 'TIERSANON', name: 'x', discount_type: 'fixed', discount_value: 9999 }],
  ['customer_credit_ledger', { customer_id: A.id, entry_type: 'EXCESS', amount: 9999, balance_after: 9999 }],
  ['guest_inquiries', { name: 'TIERS', email: 'tiers-anon@test.local' }]
];
for (const [table, body] of anonWrites) {
  const r = await rest(table, { token: ANONT, method: 'POST', body });
  check(`signed-out visitor cannot insert into ${table}`, !r.ok, r.ok ? 'ACCEPTED' : `${r.status}`);
}
for (const [table, patch, filter] of [['business_config', { business_name: 'HACKED' }, 'id=gt.0'], ['bookings', { total_amount: 1 }, `id=eq.${ids.A}`], ['payments', { status: 'REJECTED' }, `id=eq.${payA}`], ['profiles', { role: 'ADMIN' }, `id=eq.${A.id}`]]) {
  const r = await rest(`${table}?${filter}`, { token: ANONT, method: 'PATCH', body: patch });
  const changed = r.ok ? (await json(r)).length : 0;
  check(`signed-out visitor cannot update ${table}`, changed === 0, changed ? `${changed} row(s) changed` : '');
}
check('the shop name is intact', sql('select business_name from public.business_config limit 1') !== 'HACKED');

// =====================================================================================================================
section('2. Customer A: reads limited to their own data');
const own = (table, col) => async () => { const r = await get(table, 'select=*&limit=1000', A.token); const list = rows(r); const foreign = list.filter((row) => row[col] !== A.id); return { total: list.length, foreign: foreign.length }; };
const ownByBooking = (table) => async () => {
  const mine = new Set(sql(`select id from public.bookings where customer_id='${A.id}'`).split('\n').filter(Boolean));
  const r = await get(table, 'select=*&limit=1000', A.token); const list = rows(r);
  return { total: list.length, foreign: list.filter((row) => !mine.has(row.booking_id)).length };
};
const scoped = {
  bookings: own('bookings', 'customer_id'), vehicles: own('vehicles', 'owner_id'), notifications: own('notifications', 'user_id'), profiles: own('profiles', 'id'),
  customer_credit_ledger: own('customer_credit_ledger', 'customer_id'), payments: ownByBooking('payments'), booking_vehicles: ownByBooking('booking_vehicles'),
  booking_messages: async () => { const list = rows(await get('booking_messages', 'select=*&limit=1000', A.token)); return { total: list.length, foreign: list.filter((m) => m.customer_id !== A.id && m.sender_id !== A.id).length }; }, service_photos: ownByBooking('service_photos'), refund_proofs: ownByBooking('refund_proofs'),
  booking_ledger_v: ownByBooking('booking_ledger_v'), payment_ledger_v: ownByBooking('payment_ledger_v')
};
for (const [table, fn] of Object.entries(scoped)) {
  const { total, foreign } = await fn();
  check(`customer A sees only their own ${table}`, foreign === 0, `${total} visible, ${foreign} belong to others`);
}
{
  const mine = new Set(sql(`select id from public.bookings where customer_id='${A.id}'`).split('\n').filter(Boolean));
  const list = rows(await get('audit_logs', 'select=booking_id,actor_id,action_type&limit=1000', A.token));
  const foreign = list.filter((l) => !(mine.has(l.booking_id) || l.actor_id === A.id));
  check('customer A sees only the audit entries of their own bookings and actions', foreign.length === 0, `${list.length} visible, ${foreign.length} foreign`);
}
for (const table of ['staff_attendance', 'invites', 'pending_registrations', 'account_recovery_otps', 'qr_change_otp', 'password_confirmation_requests', 'login_security_notices', 'guest_inquiries', 'guest_inquiry_messages', 'booking_email_deliveries']) {
  const r = await get(table, 'select=*&limit=10', A.token);
  const real = Number(sql(`select count(*) from public.${table}`));
  check(`customer A cannot read ${table}`, rows(r).length === 0, `${rows(r).length} of ${real}`);
}

// =====================================================================================================================
section('3. Customer A: writes they must not be able to make');
const snap = () => sql(`select role||'|'||coalesce(can_view_reports::text,'')||'|'||is_active||'|'||coalesce(accepted_terms_version,0)||'|'||coalesce(failed_login_attempts,0)||'|'||coalesce(must_change_password::text,'')||'|'||is_clocked_in from public.profiles where id='${A.id}'`);
for (const patch of [{ role: 'ADMIN' }, { role: 'STAFF' }, { can_view_reports: true }, { is_active: false }, { accepted_terms_version: 99 }, { failed_login_attempts: 3 }, { must_change_password: false }, { is_clocked_in: true }]) {
  const profileBefore = snap();
  const r = await rest(`profiles?id=eq.${A.id}`, { token: A.token, method: 'PATCH', body: patch });
  const after = snap();
  check(`customer A cannot change their own profile ${Object.keys(patch)[0]}`, after === profileBefore, `${r.status} ${after === profileBefore ? '' : 'CHANGED to ' + after}`);
  if (after !== profileBefore) await rest(`profiles?id=eq.${A.id}`, { method: 'PATCH', body: { role: 'CUSTOMER', can_view_reports: false, is_active: true, accepted_terms_version: 1, failed_login_attempts: 0, must_change_password: false, is_clocked_in: false } });
}
const tryWrite = async (name, fn, verify) => { const r = await fn(); const ok = await verify(r); check(name, ok, ok ? '' : `allowed (${r.status})`); };
await tryWrite('customer A cannot lower their own booking total', () => rest(`bookings?id=eq.${ids.A}`, { token: A.token, method: 'PATCH', body: { total_amount: 1 } }), () => Number(state(`select total_amount from public.bookings where id='${ids.A}'`)) === 500);
await tryWrite('customer A cannot set their own booking status', () => rest(`bookings?id=eq.${ids.A}`, { token: A.token, method: 'PATCH', body: { status: 'completed', payment_status: 'paid', refund_status: 'QUEUED' } }), () => state(`select status||refund_status from public.bookings where id='${ids.A}'`) === 'confirmed' || state(`select status from public.bookings where id='${ids.A}'`) === 'confirmed');
await tryWrite('customer A cannot verify their own payment', () => rest(`payments?id=eq.${payA}`, { token: A.token, method: 'PATCH', body: { status: 'PAID', amount: 99999 } }), () => Number(state(`select amount from public.payments where id='${payA}'`)) === 500);
await tryWrite('customer A cannot insert a verified payment', () => rest('payments', { token: A.token, method: 'POST', body: { booking_id: ids.A, amount: 5000, method: 'Cash', status: 'PAID', payment_type: 'Full' } }), () => Number(state(`select count(*) from public.payments where booking_id='${ids.A}' and amount=5000`)) === 0);
await tryWrite('customer A cannot delete their payment record', () => rest(`payments?id=eq.${payA}`, { token: A.token, method: 'DELETE' }), () => Number(state(`select count(*) from public.payments where id='${payA}'`)) === 1);
await tryWrite('customer A cannot create credit for themselves', () => rest('customer_credit_ledger', { token: A.token, method: 'POST', body: { customer_id: A.id, booking_id: ids.A, entry_type: 'EXCESS', amount: 9999, balance_after: 9999 } }), () => Number(state(`select count(*) from public.customer_credit_ledger where customer_id='${A.id}' and amount=9999`)) === 0);
await tryWrite('customer A cannot write the audit log', () => rest('audit_logs', { token: A.token, method: 'POST', body: { action_type: 'TIERS_FORGED', details: 'forged', booking_id: ids.A } }), () => Number(state(`select count(*) from public.audit_logs where action_type='TIERS_FORGED'`)) === 0);
await tryWrite('customer A cannot send a notification to someone else', () => rest('notifications', { token: A.token, method: 'POST', body: { user_id: B.id, title: 'TIERS phish', message: 'Pay to 09170000000', notification_type: 'SYSTEM' } }), () => Number(state(`select count(*) from public.notifications where title='TIERS phish'`)) === 0);
await tryWrite('customer A cannot change another customer\'s booking', () => rest(`bookings?id=eq.${ids.B}`, { token: A.token, method: 'PATCH', body: { status: 'cancelled' } }), () => state(`select status from public.bookings where id='${ids.B}'`) === 'confirmed');
await tryWrite('customer A cannot delete another customer\'s booking', () => rest(`bookings?id=eq.${ids.B}`, { token: A.token, method: 'DELETE' }), () => Number(state(`select count(*) from public.bookings where id='${ids.B}'`)) === 1);
await tryWrite('customer A cannot write a message into another customer\'s booking chat', () => rest('booking_messages', { token: A.token, method: 'POST', body: { booking_id: ids.B, sender_id: A.id, message: 'TIERS spoof', message_text: 'TIERS spoof', is_read: false } }), () => Number(state(`select count(*) from public.booking_messages where message='TIERS spoof'`)) === 0);
await tryWrite('customer A cannot post a message as another person', () => rest('booking_messages', { token: A.token, method: 'POST', body: { booking_id: ids.A, sender_id: B.id, message: 'TIERS impersonation', message_text: 'TIERS impersonation', is_read: false } }), () => Number(state(`select count(*) from public.booking_messages where message='TIERS impersonation'`)) === 0);
await tryWrite('customer A cannot add a service photo', () => rest('service_photos', { token: A.token, method: 'POST', body: { booking_id: ids.A, booking_vehicle_id: '9a000000-0000-0000-0000-00000000a0e1', phase: 'before', storage_path: 'tiers/x.jpg', uploaded_by: A.id } }), () => Number(state(`select count(*) from public.service_photos where storage_path='tiers/x.jpg'`)) === 0);
await tryWrite('customer A cannot change the shop settings', () => rest('business_config?id=gt.0', { token: A.token, method: 'PATCH', body: { business_name: 'HACKED' } }), () => state('select business_name from public.business_config limit 1') !== 'HACKED');
await tryWrite('customer A cannot create a promo code', () => rest('promo_codes', { token: A.token, method: 'POST', body: { code: 'TIERSCUST', name: 'x', discount_type: 'fixed', discount_value: 9999 } }), () => Number(state(`select count(*) from public.promo_codes where code='TIERSCUST'`)) === 0);
await tryWrite('customer A cannot insert a booking directly (bypassing the checks)', () => rest('bookings', { token: A.token, method: 'POST', body: { customer_id: A.id, customer_name: 'TIERS direct', status: 'confirmed', payment_status: 'paid', total_amount: 0, start_datetime: new Date(Date.now() + 3 * 86400000).toISOString(), end_datetime: new Date(Date.now() + 3 * 86400000 + 3600000).toISOString(), notes: 'TIERS direct' } }), () => Number(state(`select count(*) from public.bookings where notes='TIERS direct'`)) === 0);
sql(`set session_replication_role = replica; delete from public.bookings where notes='TIERS direct'`);

section('3b. Staff: writes they must not be able to make');
await tryWrite('staff cannot insert a payment', () => rest('payments', { token: staff.token, method: 'POST', body: { booking_id: ids.A, amount: 700, method: 'Cash', status: 'PAID', payment_type: 'Full' } }), () => Number(state(`select count(*) from public.payments where booking_id='${ids.A}' and amount=700`)) === 0);
await tryWrite('staff cannot change a booking total', () => rest(`bookings?id=eq.${ids.A}`, { token: staff.token, method: 'PATCH', body: { total_amount: 1 } }), () => Number(state(`select total_amount from public.bookings where id='${ids.A}'`)) === 500);
await tryWrite('staff cannot make themselves administrator', () => rest(`profiles?id=eq.${staff.id}`, { token: staff.token, method: 'PATCH', body: { role: 'ADMIN' } }), () => state(`select role from public.profiles where id='${staff.id}'`) === 'STAFF');
await tryWrite('staff cannot grant themselves reports', () => rest(`profiles?id=eq.${staff.id}`, { token: staff.token, method: 'PATCH', body: { can_view_reports: true } }), () => state(`select coalesce(can_view_reports,false) from public.profiles where id='${staff.id}'`) === 'f');
await tryWrite('staff cannot edit another staff member', () => rest(`profiles?id=eq.${staff2.id}`, { token: staff.token, method: 'PATCH', body: { first_name: 'HACKED' } }), () => state(`select first_name from public.profiles where id='${staff2.id}'`) !== 'HACKED');
await tryWrite('staff cannot change the shop settings', () => rest('business_config?id=gt.0', { token: staff.token, method: 'PATCH', body: { business_name: 'HACKED' } }), () => state('select business_name from public.business_config limit 1') !== 'HACKED');
await tryWrite('staff cannot write refund proofs', () => rest('refund_proofs', { token: staff.token, method: 'POST', body: { booking_id: ids.A, refund_reference: 'RFD-TIERS-1', storage_path: 'x', image_hash: 'tiers-hash-1' } }), () => Number(state(`select count(*) from public.refund_proofs where refund_reference='RFD-TIERS-1'`)) === 0);
const staffPayments = await get('payments', 'select=amount,booking_id&limit=50', staff.token);
check('a technician reads no payment rows', rows(staffPayments).length === 0, `${rows(staffPayments).length} row(s)`);
const staffProfiles = await get('profiles', 'select=id,email,phone_number,role&limit=500', staff.token);
{
  const served = new Set(sql(`select distinct b.customer_id from public.bookings b where b.staff_id='${staff.id}' or exists (select 1 from public.booking_vehicles bv where bv.booking_id=b.id and bv.staff_id='${staff.id}')`).split('\n').filter(Boolean));
  const customers = rows(staffProfiles).filter((p) => p.role === 'CUSTOMER');
  const outside = customers.filter((p) => !served.has(p.id));
  check('a technician reads only the customers of their own jobs', outside.length === 0, `${customers.length} customer(s) visible, ${outside.length} not theirs`);
  check('a technician still reads colleagues and administrators', rows(staffProfiles).some((p) => p.role === 'ADMIN') && rows(staffProfiles).some((p) => p.role === 'STAFF'));
}
check('a technician cannot read the payment ledger either', rows(await get('payment_ledger_v', 'select=*&limit=5', staff.token)).length === 0);

// =====================================================================================================================
section('4. Functions: each tier against what is not theirs');
const customerLedgerB = await rpc('booking_financial_ledger', { p_booking_id: ids.B }, A.token);
check('customer A cannot read customer B\'s booking ledger', !customerLedgerB.ok || !customerLedgerB.data?.net_settled, customerLedgerB.ok ? JSON.stringify(customerLedgerB.data).slice(0, 80) : msg(customerLedgerB));
const ledgersB = await rpc('booking_ledgers', { p_booking_ids: [ids.B] }, A.token);
check('customer A cannot read customer B\'s ledgers (bulk)', !ledgersB.ok || (Array.isArray(ledgersB.data) ? ledgersB.data.length === 0 : !ledgersB.data?.length), ledgersB.ok ? JSON.stringify(ledgersB.data).slice(0, 90) : msg(ledgersB));
for (const [fn, args, label] of [
  ['payment_ocr_verdict', { p_payment_id: payB }, 'the receipt verdict of another customer\'s payment'],
  ['staff_clock_out_blockers', { p_staff: staff.id }, 'a technician\'s current jobs'],
  ['customer_booking_excess_credit', { p_customer_id: B.id, p_booking_id: ids.Bdone }, 'another customer\'s excess credit']
]) {
  const r = await rpc(fn, args, A.token);
  const leaked = r.ok && r.data !== null && r.data !== 0 && r.data !== false && !(Array.isArray(r.data) && r.data.length === 0) && r.data !== '0';
  check(`customer A cannot learn ${label} (${fn})`, !leaked, r.ok ? `returned ${JSON.stringify(r.data).slice(0, 80)}` : msg(r));
}
const settleOther = await rpc('settle_overpayment_on_completion', { p_booking_id: ids.Bdone }, A.token);
check('customer A cannot push another customer\'s excess into the refund queue', !(settleOther.ok && Number(settleOther.data?.routed) > 0), settleOther.ok ? JSON.stringify(settleOther.data) : msg(settleOther));
sql(`set session_replication_role = replica; delete from public.customer_credit_ledger where booking_id='${ids.Bdone}' and entry_type='REFUND_QUEUED'; update public.bookings set refund_status=null, refund_notes=null where id='${ids.Bdone}'`);
sql(`insert into public.promo_codes (code, name, discount_type, discount_value, max_uses) values ('TIERSCODE', 'tiers', 'fixed', 10, 3) on conflict do nothing`);
await rpc('redeem_promo_code', { p_code: 'TIERSCODE', p_customer_id: B.id }, A.token);
check('checking a promo code in another customer\'s name does not use it up', Number(sql(`select coalesce(uses_count,0) from public.promo_codes where code='TIERSCODE'`)) === 0);
{
  const vehB = '9a000000-0000-0000-0000-00000000b0e1';
  const helpers = [
    ['booking_net_paid', { p_booking_id: ids.B }], ['booking_verified_paid', { p_booking_id: ids.B }], ['booking_evidence_state', { p_booking_id: ids.B }],
    ['booking_bay_usage', { p_booking_id: ids.B }], ['booking_start_time_reached', { p_booking_id: ids.B }], ['booking_is_fully_paid', { p_booking_id: ids.B, p_override: false }],
    ['staff_booking_has_verified_downpayment', { p_booking_id: ids.B }], ['staff_on_booking', { p_booking_id: ids.B }], ['booking_has_photo_phase', { p_booking_id: ids.B, p_phase: 'before' }],
    ['vehicle_technician', { p_vehicle_id: vehB }], ['vehicle_has_photo_phase', { p_booking_vehicle_id: vehB, p_phase: 'before' }],
    ['staff_can_see_photo', { p_booking_id: ids.B, p_vehicle_id: vehB }], ['booking_total_changed_since_ocr', { p_payment_id: payB }], ['payment_ocr_verdict', { p_payment_id: payB }]
  ];
  let leaks = []; let blockedOwn = []; let blockedStaff = [];
  for (const [fn, args] of helpers) {
    const stranger = await rpc(fn, args, A.token);
    if (stranger.ok && stranger.data !== null) leaks.push(fn);
    const staffAnswer = await rpc(fn, args, staff.token);
    if (!staffAnswer.ok) blockedStaff.push(`${fn}: ${msg(staffAnswer)}`);
    const owner = await rpc(fn, args, B.token);
    if (!owner.ok) blockedOwn.push(`${fn}: ${msg(owner)}`);
  }
  check('another customer learns nothing from any booking helper function', leaks.length === 0, leaks.join(', '));
  check('the booking\'s own customer can still use them', blockedOwn.length === 0, blockedOwn.join('; '));
  check('staff can still use them', blockedStaff.length === 0, blockedStaff.join('; '));
  const own = await rpc('booking_net_paid', { p_booking_id: ids.B }, B.token);
  const asStaff = await rpc('booking_net_paid', { p_booking_id: ids.B }, staff.token);
  check('the owner and staff get the real amount (₱500)', Number(own.data) === 500 && Number(asStaff.data) === 500, `${own.data} / ${asStaff.data}`);
  check('a signed-out visitor cannot call them', !(await rpc('booking_net_paid', { p_booking_id: ids.B }, ANONT)).ok || (await rpc('booking_net_paid', { p_booking_id: ids.B }, ANONT)).data === null);
  const internalReach = await fetch(`${API}/rest/v1/rpc/booking_net_paid`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json', 'Content-Profile': 'internal' }, body: JSON.stringify({ p_booking_id: ids.B }) });
  check('the unguarded originals are not reachable through the API', !internalReach.ok, `${internalReach.status}`);
}
const rescheduleOther = await rpc('reschedule_booking', { p_booking_id: ids.B, p_start_datetime: new Date(Date.now() + 5 * 86400000).toISOString(), p_end_datetime: new Date(Date.now() + 5 * 86400000 + 3600000).toISOString(), p_reason: 'tiers' }, A.token);
check('customer A cannot reschedule another customer\'s booking', !rescheduleOther.ok, rescheduleOther.ok ? 'ACCEPTED' : msg(rescheduleOther));
const askOther = await rpc('request_excess_refund', { p_booking_id: ids.Bdone }, A.token);
check('customer A cannot request a refund on another customer\'s booking', !askOther.ok, askOther.ok ? 'ACCEPTED' : msg(askOther));
const ADMIN_ONLY = [
  ['process_booking_refund_v2', { p_booking_id: ids.A, p_refund_amount: 1, p_refund_reason: 'x', p_refund_reference: 'RFD-TIERS-X', p_refund_deduction: 0, p_refund_method: 'CASH', p_actor_id: null }],
  ['process_overpayment_credit_refund_v2', { p_booking_id: ids.Bdone, p_refund_amount: 1, p_refund_reason: 'x', p_refund_reference: 'RFD-TIERS-Y', p_refund_method: 'CASH', p_actor_id: null }],
  ['admin_verify_payment', { p_payment_id: payA, p_booking_id: ids.A, p_verified_amount: 500, p_note: 'x', p_override: false }],
  ['admin_reject_payment', { p_payment_id: payA, p_booking_id: ids.A, p_reason: 'x', p_queue_refund: false, p_refund_note: null }],
  ['admin_record_receivable', { p_booking_id: ids.A, p_note: 'x' }],
  ['sales_report', { p_from: new Date(Date.now() - 86400000).toISOString(), p_to: new Date().toISOString() }],
  ['daily_report', { p_day: new Date().toISOString().slice(0, 10), p_to: new Date().toISOString().slice(0, 10) }],
  ['bookings_report', { p_from: new Date(Date.now() - 86400000).toISOString(), p_to: new Date().toISOString() }],
  ['admin_chat_threads', {}], ['admin_guest_inquiry_threads', {}], ['flagged_bookings_for_review', {}],
  ['mark_guest_inquiry_read', { p_inquiry: crypto.randomUUID() }],
  ['staff_work_history', { p_staff: staff2.id, p_before: null, p_days: 3 }],
  ['staff_work_history_range', { p_staff: staff2.id, p_from: '2026-10-01', p_to: '2026-10-10' }],
  ['run_no_show_lifecycle', {}], ['flag_no_show_bookings', {}], ['remind_unstarted_services', {}]
];
for (const [fn, args] of ADMIN_ONLY) {
  for (const [who, tok] of [['signed-out visitor', ANONT], ['customer', A.token], ['staff', staff.token]]) {
    const r = await rpc(fn, args, tok);
    const wasRefused = !r.ok;
    check(`${who} cannot run ${fn}`, wasRefused, r.ok ? 'ALLOWED ' + JSON.stringify(r.data).slice(0, 70) : '');
  }
}
// ---- failed-login lock-out: per account AND per visitor address -------------------------------------------------------
{
  const from = async (ip, fn, args = { p_email: B.email }, token = ANONT) => { const r = await rest(`rpc/${fn}`, { token, method: 'POST', body: args, headers: { 'cf-connecting-ip': ip } }); return { ok: r.ok, status: r.status, data: await json(r) }; };
  const resetB = async () => { sql(`delete from public.login_throttle where email='${B.email}'`); sql(`delete from public.login_security_notices where email='${B.email}'`); await rest(`profiles?id=eq.${B.id}`, { method: 'PATCH', body: { failed_login_attempts: 0, locked_until: null, lockout_stage: 0, stage_failed_attempts: 0, security_notice_sent_at: null } }); };
  await resetB();
  // an attacker hammers the victim's e-mail from one address
  let last;
  for (let i = 0; i < 5; i += 1) last = await from('203.0.113.7', 'register_failed_login_staged');
  check('five wrong passwords from one address lock THAT address (the lock really applies now)', last.ok && last.data?.locked === true, JSON.stringify(last.data).slice(0, 90));
  const attackerView = await from('203.0.113.7', 'check_login_lock');
  const ownerView = await from('198.51.100.20', 'check_login_lock');
  check('the attacker\'s address sees the lock', attackerView.data?.locked === true);
  check('the real owner, from another address, is NOT locked out by it', ownerView.data?.locked === false, JSON.stringify(ownerView.data).slice(0, 80));
  check('the account itself carries no lock', sql(`select locked_until is null from public.profiles where id='${B.id}'`) === 't');
  check('a signed-out visitor cannot switch the lock off', (await from('203.0.113.7', 'clear_login_lock')).data?.cleared === false && (await from('203.0.113.7', 'check_login_lock')).data?.locked === true);
  const foreignClear = await from('198.51.100.20', 'clear_login_lock', { p_email: B.email }, A.token);
  check('another signed-in customer cannot switch it off either', foreignClear.data?.cleared === false);
  const ownerClear = await from('198.51.100.20', 'clear_login_lock', { p_email: B.email }, B.token);
  check('the owner, once signed in, clears it', ownerClear.data?.cleared === true && (await from('203.0.113.7', 'check_login_lock')).data?.locked === false);

  // the ladder reaches the security notice, and the owner is told once however many addresses push on
  await resetB();
  let escalated = null;
  for (let round = 0; round < 40 && !escalated; round += 1) {
    const r = await from('203.0.113.8', 'register_failed_login_staged');
    if (r.data?.escalated) escalated = r.data;
    else if (r.data?.locked) sql(`update public.login_throttle set locked_until = now() - interval '1 second' where email='${B.email}'`);
  }
  check('one address pushing on reaches the escalation step', Boolean(escalated), JSON.stringify(escalated).slice(0, 100));
  sql(`update public.login_throttle set locked_until = now() - interval '1 second' where email='${B.email}'`);
  for (let round = 0; round < 40; round += 1) {
    const r = await from('203.0.113.9', 'register_failed_login_staged');
    if (r.data?.escalated) break;
    if (r.data?.locked) sql(`update public.login_throttle set locked_until = now() - interval '1 second' where email='${B.email}' and client_key <> ''`);
  }
  check('the owner is e-mailed once, not once per attacking address', Number(sql(`select count(*) from public.login_security_notices where email='${B.email}'`)) <= 1, `${sql(`select count(*) from public.login_security_notices where email='${B.email}'`)} notice(s)`);
  check('still, the owner from a clean address can sign in', (await from('198.51.100.21', 'check_login_lock')).data?.locked === false);

  // an attack spread over many addresses holds the account briefly
  await resetB();
  let spread;
  for (let i = 0; i < 6; i += 1) spread = await from(`192.0.2.${10 + i}`, 'register_failed_login_staged');
  const spreadView = await from('198.51.100.22', 'check_login_lock');
  check('failures from many different addresses put a short hold on the account', spreadView.data?.locked === true && spreadView.data?.minutes_left <= 15, JSON.stringify(spreadView.data).slice(0, 90));
  const noNotice = await from('198.51.100.22', 'register_failed_login_staged', { p_email: 'nobody-here@example.com' });
  check('an unknown e-mail gets the same neutral answer (no account reveal)', noNotice.data?.locked === false && noNotice.data?.attempts_remaining === 4);
  await resetB();
}

// =====================================================================================================================
section('5. The server routes, tier by tier');
const receipt = await api(`/api/bookings/${ids.B}/receipt`, { method: 'GET' });
check('a signed-out visitor cannot fetch a booking receipt (with the customer\'s details)', !receipt.ok, receipt.ok ? 'returned the booking with ' + Object.keys(receipt.data?.data || {}).length + ' fields' : '');
const garage = await api('/api/garage/sync', { body: { customerId: B.id, vehicle: { plateNumber: 'TIERSFAKE', brand: 'x', model: 'y' } } });
check('a signed-out visitor cannot add a vehicle to someone\'s garage', !garage.ok, garage.ok ? 'ACCEPTED' : msg(garage));
sql(`delete from public.vehicles where plate_number='TIERSFAKE'`);
const adminRoutes = [
  ['POST', '/api/admin/promos', { name: 'x' }], ['POST', '/api/admin/broadcast', { message: 'x' }], ['GET', '/api/admin/profiles'], ['PATCH', `/api/admin/staff/${staff.id}`, { first_name: 'X' }],
  ['POST', '/api/admin/purge-bookings', {}], ['POST', '/api/admin/blocked-slots', { block_date: '2030-01-01' }], ['POST', '/api/admin/invite-account', { email: 'tiers-x@test.local' }],
  ['POST', '/api/admin/revoke-access', { userId: staff.id }], ['POST', '/api/admin/reactivate-staff', { userId: staff.id }], ['POST', '/api/admin/refunds/proof/discard', { bookingId: ids.A, refundReference: 'RFD-X' }],
  ['POST', '/api/admin/inquiries/reply', { inquiryId: crypto.randomUUID(), body: 'x' }], ['POST', '/api/bookings/admin-cancel', { bookingId: ids.A, reason: 'x' }], ['POST', '/api/bookings/undo-no-show', { bookingId: ids.A }],
  ['GET', '/api/debug/user/cust@test.local'], ['POST', '/admin/generate-invite', { email: 'tiers-y@test.local' }], ['POST', '/api/admin/analytics-assistant', { question: 'x' }], ['POST', '/api/admin/services/usage', {}]
];
for (const [method, path, body] of adminRoutes) {
  for (const [who, token] of [['signed-out visitor', undefined], ['customer', A.token], ['staff', staff.token]]) {
    const r = await api(path, { method, token, body });
    check(`${who} cannot use ${method} ${path}`, !r.ok && [400, 401, 403, 404].includes(r.status), `${r.status}${r.ok ? ' ALLOWED' : ''}`);
  }
}
check('the purge route did not remove anything', Number(sql(`select count(*) from public.bookings where id='${ids.A}'`)) === 1);
const cancelOther = await api('/api/bookings/cancel', { token: A.token, body: { bookingId: ids.B, reason: 'tiers' } });
check('customer A cannot cancel another customer\'s booking', !cancelOther.ok && sql(`select status from public.bookings where id='${ids.B}'`) === 'confirmed', `${cancelOther.status} ${msg(cancelOther)}`);
const noToken = await api('/api/bookings/cancel', { body: { bookingId: ids.A, reason: 'tiers' } });
check('a signed-out visitor cannot cancel a booking', !noToken.ok && sql(`select status from public.bookings where id='${ids.A}'`) === 'confirmed', `${noToken.status}`);
for (const [path, body] of [['/api/bookings/update-status', { bookingId: ids.A, newStatus: 'COMPLETED', actorName: 'x', actorRole: 'ADMIN' }], ['/api/bookings/update-master-status', { bookingId: ids.A, newStatus: 'completed' }], ['/api/bookings/release', { bookingId: ids.A }], ['/api/bookings/reconcile-payment-state', { bookingId: ids.B }], ['/api/staff/toggle-shift', { userId: staff.id }]]) {
  const r = await api(path, { token: A.token, body });
  check(`a customer cannot use ${path}`, !r.ok, `${r.status}${r.ok ? ' ALLOWED' : ''}`);
}
check('the booking was not completed by those calls', sql(`select status from public.bookings where id='${ids.A}'`) === 'confirmed');
const addOther = await api('/api/bookings/add-service', { token: A.token, body: { bookingId: ids.B, services: [{ serviceName: 'Basic Carwash', price: 1, vehicleId: '9a000000-0000-0000-0000-00000000b0e1' }] } });
check('customer A cannot add a service to another customer\'s booking', !addOther.ok, `${addOther.status} ${msg(addOther)}`);
const addCheap = await api('/api/bookings/add-service', { token: A.token, body: { bookingId: ids.A, services: [{ serviceName: 'Basic Carwash', price: 1, vehicleId: '9a000000-0000-0000-0000-00000000a0e1' }] } });
check('a service cannot be added at a price the customer made up', !addCheap.ok, `${addCheap.status} ${msg(addCheap)}`);
const staffTasksNoAuth = await api('/api/staff/tasks', { method: 'GET' });
check('the staff task list needs a sign-in', !staffTasksNoAuth.ok, `${staffTasksNoAuth.status}`);
const staffTasksCustomer = await api('/api/staff/tasks', { method: 'GET', token: A.token });
check('a customer cannot read the staff task list', !staffTasksCustomer.ok, `${staffTasksCustomer.status}`);

// =====================================================================================================================
section('6. Public forms and hostile input');
const inq = (over = {}) => api('/api/public/inquiry', { body: { name: 'Tiers Guest', email: `tiers-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, message: 'A normal question about prices.', ...over } });
{ const r = await inq(); check('a normal website inquiry is accepted (or the per-visitor limit has been reached)', r.ok || r.status === 429, String(r.status)); }
for (const [label, over] of [
  ['an empty message', { message: '' }], ['an invalid email', { email: 'not-an-email' }], ['an email with a header injection', { email: 'a@b.com\r\nBcc: victim@example.com' }],
  ['a one-letter name', { name: 'A' }], ['a name that is only spaces', { name: '     ' }], ['an array instead of text', { message: ['x', 'y'] }], ['an object instead of text', { name: { a: 1 } }]
]) {
  const r = await inq(over);
  check(`a website inquiry with ${label} is refused`, !r.ok && r.status < 500, `${r.status} ${msg(r)}`);
}
const longOne = await inq({ message: 'x'.repeat(50000) });
note(`a 50,000-character inquiry: ${longOne.status} ${longOne.ok ? '(accepted and cut to 2000)' : msg(longOne)}`);
const stored = sql(`select max(char_length(body)) from public.guest_inquiry_messages m join public.guest_inquiries i on i.id=m.inquiry_id where i.name='Tiers Guest'`);
check('a long inquiry is cut to the limit, not stored whole', Number(stored || 0) <= 2000, `longest stored ${stored}`);
const bad = await api('/api/public/inquiry', { raw: '{not json' });
check('malformed JSON gives a clean 400, not a crash', bad.status === 400, `${bad.status}`);
const huge = await api('/api/public/inquiry', { raw: JSON.stringify({ name: 'x', email: 'a@b.co', message: 'x'.repeat(5 * 1024 * 1024) }) });
check('a 5 MB body is refused without crashing the server', !huge.ok && huge.status < 500, `${huge.status}`);
const xss = await inq({ name: '<script>alert(1)</script>', message: '<img src=x onerror=alert(1)> hello there' });
check('markup in an inquiry is accepted as plain text (shown escaped)', xss.ok || xss.status === 400 || xss.status === 429, `${xss.status}`);
let throttled = 0; const sameEmail = `tiers-flood-${tag}@example.com`;
for (let i = 0; i < 9; i += 1) { const r = await api('/api/public/inquiry', { body: { name: 'Flood', email: sameEmail, message: `message number ${i} here` } }); if (r.status === 429) throttled += 1; }
check('flooding from one address is throttled', throttled >= 1, `${throttled} of 9 throttled`);
const honey = await api('/api/public/inquiry', { body: { name: 'Bot', email: `tiers-bot-${tag}@example.com`, message: 'buy pills now', website: 'http://spam' } });
check('the hidden bot field is answered but stores nothing', honey.ok && Number(sql(`select count(*) from public.guest_inquiries where email='tiers-bot-${tag}@example.com'`)) === 0);
const reportNoAuth = await api('/api/support/report', { body: { message: 'hello there support' } });
check('a signed-out visitor cannot send a support report', !reportNoAuth.ok, `${reportNoAuth.status}`);
const reportOK = await api('/api/support/report', { token: A.token, body: { message: 'x'.repeat(9000), kind: 'ISSUE' } });
note(`a 9,000-character support report from a customer: ${reportOK.status} (${msg(reportOK)})`);
const reportKind = await api('/api/support/report', { token: A.token, body: { message: 'hello there support', kind: 'DROP TABLE' } });
check('an unknown report type is refused', !reportKind.ok && reportKind.status === 400, `${reportKind.status}`);

// =====================================================================================================================
section('7. Many at once');
const balanceCheck = (id) => Number(sql(`select coalesce(sum(case when method='SYSTEM_REFUND' then amount else amount end),0) from public.payments where booking_id='${id}'`));
// ten simultaneous requests for the same excess refund
const racer = '9a000000-0000-0000-0000-00000000c001';
sql(`set session_replication_role = replica; insert into public.bookings (id, customer_id, customer_name, status, payment_status, total_amount, start_datetime, end_datetime, notes) values ('${racer}', '${A.id}', 'Tiers Race', 'confirmed', 'paid', 500, now() + interval '4 days', now() + interval '4 days 1 hour', 'TIERS race'); set session_replication_role = origin; insert into public.payments (booking_id, amount, method, payment_type, status, reference_number) values ('${racer}', 800, 'GCash', 'Full', 'PAID', 'TIERSRACE${tag}');`);
ids.racer = racer;
const asks = await Promise.all(Array.from({ length: 10 }, () => rpc('request_excess_refund', { p_booking_id: racer }, A.token)));
const queued = Number(sql(`select count(*) from public.customer_credit_ledger where booking_id='${racer}' and entry_type='REFUND_QUEUED'`));
check('ten simultaneous excess-refund requests queue it exactly once', queued === 1, `${queued} entries, ${asks.filter((a) => a.ok && Number(a.data?.routed) > 0).length} said routed`);
// simultaneous refunds on one booking can never exceed what was paid
sql(`update public.profiles set is_active=true where id='${admin.id}'`);
const refundRace = await Promise.all(Array.from({ length: 6 }, (_, i) => rpc('process_overpayment_credit_refund_v2', { p_booking_id: racer, p_refund_amount: 300, p_refund_reason: 'Excess payment', p_refund_reference: `RFD-TIERS-R${tag}${i}`, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token)));
const refunded = Math.abs(Number(sql(`select coalesce(sum(amount),0) from public.payments where booking_id='${racer}' and method='SYSTEM_REFUND'`)));
check('six simultaneous ₱300 refunds of a ₱300 excess pay out ₱300 only', refunded === 300, `refunded ${refunded}, ${refundRace.filter((r) => r.ok).length} succeeded`);
// two admins verifying the same receipt at once
const dupPay = sql(`insert into public.payments (booking_id, amount, method, payment_type, status, reference_number) values ('${ids.A}', 120, 'GCash', 'Manual', 'FOR_VERIFICATION', 'TIERSVER${tag}') returning id`).split('\n')[0];
const verifies = await Promise.all(Array.from({ length: 5 }, () => rpc('admin_verify_payment', { p_payment_id: dupPay, p_booking_id: ids.A, p_verified_amount: 120, p_note: 'race', p_override: false }, admin.token)));
const paidTimes = Number(sql(`select count(*) from public.payments where id='${dupPay}' and status='PAID'`));
const netA = Number(sql(`select net_settled from public.booking_ledger_v where booking_id='${ids.A}'`));
check('five simultaneous verifications count the payment once', paidTimes === 1 && netA === 620, `net settled ${netA}, ${verifies.filter((v) => v.ok).length} succeeded`);
// promo code used by many at once
sql(`insert into public.promo_codes (code, name, discount_type, discount_value, max_uses) values ('TIERSLIM', 'limit one', 'fixed', 10, 1) on conflict do nothing`);
const redeems = await Promise.all([A, B, A, B, A, B].map((who) => rpc('redeem_promo_code', { p_code: 'TIERSLIM', p_customer_id: who.id }, who.token)));
const uses = Number(sql(`select coalesce(uses_count,0) from public.promo_codes where code='TIERSLIM'`));
check('a one-use promo code is used once even when six people try together', uses <= 1, `used ${uses}, ${redeems.filter((r) => r.ok).length} succeeded`);
// slot capacity under a burst of bookings

// a burst of bookings for one slot never goes beyond what the shop can serve
{
  const cap = (await rpc('shop_capacity', {}, admin.token)).data;
  const d = new Date(Date.now() + 8 * 3600000 + 6 * 86400000);
  let day = new Date(d); while (day.getUTCDay() === 0) day = new Date(day.getTime() + 86400000);
  const ymd = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
  const price = Number((await rpc('catalog_service_price', { p_name: 'Basic Carwash', p_vehicle_type: 'Sedan' }, admin.token)).data);
  const make = (i) => rpc('create_booking_atomic_secure', { p_payload: {
    booking: { customer_id: A.id, customer_name: 'Tiers Burst', customer_email: 'cust@test.local', contact_number: '09171234567', start_datetime: `${ymd}T10:00:00+08:00`, end_datetime: `${ymd}T11:00:00+08:00`, status: 'confirmed', total_amount: price, vehicle_type: 'Sedan', discount_amount_snapshot: 0, notes: 'TIERS burst', service_snapshot: [], service_snapshot_version: 1, is_walk_in: true },
    vehicles: [{ vehicle: { vehicle_type: 'Sedan', brand: 'Test', model: 'Car', plate_number: `TB${tag}${i}`, status: 'CONFIRMED' }, services: [{ service_name: 'Basic Carwash', price, final_price: price }] }],
    payment: { amount: price, method: 'Cash', payment_type: 'Full', status: 'PAID', verified_by: admin.id, verified_at: new Date().toISOString(), notes: 'ADMIN_CONFIRMED_CASH' }
  } }, admin.token);
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => make(i)));
  const accepted = burst.filter((r) => r.ok).length;
  const inSlot = Number(sql(`select count(*) from public.bookings where notes='TIERS burst' and status not in ('cancelled')`));
  check(`eight simultaneous bookings for one slot stay within the shop's capacity (${cap?.effective ?? '?'} bays)`, accepted >= 1 && accepted <= Number(cap?.effective || 2), `${accepted} accepted, ${inSlot} stored; first refusal: ${msg(burst.find((r) => !r.ok) || { data: '-' })}`);
  sql(`set session_replication_role = replica; delete from public.payments where booking_id in (select id from public.bookings where notes='TIERS burst'); delete from public.booking_vehicle_services where booking_vehicle_id in (select id from public.booking_vehicles where booking_id in (select id from public.bookings where notes='TIERS burst')); delete from public.booking_vehicles where booking_id in (select id from public.bookings where notes='TIERS burst'); delete from public.audit_logs where booking_id in (select id from public.bookings where notes='TIERS burst'); delete from public.notifications where booking_id in (select id from public.bookings where notes='TIERS burst'); delete from public.customer_credit_ledger where booking_id in (select id from public.bookings where notes='TIERS burst'); delete from public.bookings where notes='TIERS burst'`);
}

// =====================================================================================================================
section('8. Hostile values in money');
const negative = await rpc('process_booking_refund_v2', { p_booking_id: ids.A, p_refund_amount: -50, p_refund_reason: 'x', p_refund_reference: `RFD-TIERS-N${tag}`, p_refund_deduction: 0, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token);
check('a negative refund amount is refused', !negative.ok, negative.ok ? 'ACCEPTED' : msg(negative));
const deductNeg = await rpc('process_booking_refund_v2', { p_booking_id: ids.A, p_refund_amount: 10, p_refund_reason: 'x', p_refund_reference: `RFD-TIERS-D${tag}`, p_refund_deduction: -500, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token);
check('a negative deduction (to refund more than was paid) is refused', !deductNeg.ok || Math.abs(Number(sql(`select coalesce(sum(amount),0) from public.payments where booking_id='${ids.A}' and method='SYSTEM_REFUND'`))) <= 620, deductNeg.ok ? 'ACCEPTED ' + JSON.stringify(deductNeg.data).slice(0, 80) : msg(deductNeg));
const nanRefund = await rpc('process_booking_refund_v2', { p_booking_id: ids.A, p_refund_amount: 'NaN', p_refund_reason: 'x', p_refund_reference: `RFD-TIERS-M${tag}`, p_refund_deduction: 0, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token);
check('a NaN refund amount is refused', !nanRefund.ok, nanRefund.ok ? 'ACCEPTED' : msg(nanRefund));
const emptyReason = await rpc('process_booking_refund_v2', { p_booking_id: ids.A, p_refund_amount: 10, p_refund_reason: '   ', p_refund_reference: `RFD-TIERS-E${tag}`, p_refund_deduction: 0, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token);
check('a refund without a reason is refused', !emptyReason.ok, emptyReason.ok ? 'ACCEPTED' : msg(emptyReason));
const sameRef = `RFD-TIERS-S${tag}`;
sql(`set session_replication_role = replica; update public.bookings set status='cancelled' where id='${ids.A}'`);
const first = await rpc('process_booking_refund_v2', { p_booking_id: ids.A, p_refund_amount: 5, p_refund_reason: 'x', p_refund_reference: sameRef, p_refund_deduction: 0, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token);
const second = await rpc('process_booking_refund_v2', { p_booking_id: ids.A, p_refund_amount: 5, p_refund_reason: 'x', p_refund_reference: sameRef, p_refund_deduction: 0, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token);
check('the same refund reference cannot be used twice', first.ok && !second.ok, `${first.ok}/${second.ok}`);
const actorMismatch = await rpc('process_booking_refund_v2', { p_booking_id: ids.A, p_refund_amount: 5, p_refund_reason: 'x', p_refund_reference: `RFD-TIERS-A${tag}`, p_refund_deduction: 0, p_refund_method: 'CASH', p_actor_id: A.id }, admin.token);
check('a refund cannot be filed in another person\'s name', !actorMismatch.ok, actorMismatch.ok ? 'ACCEPTED' : msg(actorMismatch));

// =====================================================================================================================
section('9. Cleaning up');
cleanup();
sql(`set session_replication_role = replica; delete from public.payments where booking_id='${racer}'; delete from public.customer_credit_ledger where booking_id='${racer}'; delete from public.audit_logs where booking_id='${racer}'; delete from public.notifications where booking_id='${racer}'; delete from public.bookings where id='${racer}'; delete from public.guest_inquiries where name in ('Tiers Guest','Flood','Bot') or email like 'tiers-%'; delete from public.notifications where notification_type='GUEST_INQUIRY'; delete from public.promo_codes where code like 'TIERS%'`);
await rest(`profiles?id=in.(${A.id},${B.id})`, { method: 'PATCH', body: { failed_login_attempts: 0, locked_until: null, lockout_stage: 0, stage_failed_attempts: 0 } });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tier checks passed; ${failed.length} finding(s)`);
for (const f of failed) console.log(`  FINDING: ${f.name}`);
process.exit(failed.length ? 1 : 0);
void balanceCheck;
