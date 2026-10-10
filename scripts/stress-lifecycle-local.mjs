/**
 * End-to-end lifecycle stress test for the LOCAL scratch stack only (never production).
 *
 *   node scripts/stress-lifecycle-local.mjs --api http://127.0.0.1:55421 --anon <key> --service <key> --backend http://localhost:3999
 *
 * Phase A  bookings with every payment type; verify, assign, start, finish, cancel, refund, reschedule
 * Phase B  change every aspect of the Business Hub (hours, bays, lead time, window, closed days, downpayment policy,
 *          vehicle types, services and prices, promo rule, promo code, shop closure)
 * Phase C  the same flows again: each new rule must be enforced
 * Phase D  audit logs and reports must see all of it and agree with the payment records
 * Phase E  the admin edits staff details
 * The business configuration is put back at the end. Everything created is tagged LIFECYCLE and removed again.
 */
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), SERVICE = arg('service'), BACKEND = arg('backend') || 'http://localhost:3999';
if (!API || !ANON || !SERVICE) { console.error('Missing --api / --anon / --service'); process.exit(2); }
for (const url of [API, BACKEND]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) { console.error('Refusing non-local host'); process.exit(2); }
}
import { execFileSync } from 'node:child_process';
const DB = arg('db') || 'supabase_db_speedway-ledger-test';
const sql = (statement) => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', statement], { encoding: 'utf8' });
process.env.__API = API; process.env.__ANON = ANON;
const PASSWORD = 'LocalTest-123';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };
const note = (text) => console.log(`      ${text}`);
const section = (text) => console.log(`\n=== ${text}`);

const login = async (email) => {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return { token: j.access_token, id: j.user.id, email };
};
const rest = (path, { token = SERVICE, method = 'GET', body, headers = {} } = {}) =>
  fetch(`${API}/rest/v1/${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const rpc = async (fn, args, token) => { const r = await rest(`rpc/${fn}`, { token, method: 'POST', body: args }); return { ok: r.ok, status: r.status, data: await json(r) }; };
const api = async (path, { token, method = 'POST', body } = {}) => {
  const r = await fetch(`${BACKEND}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, data: await json(r) };
};
const message = (r) => String(r.data?.message || r.data?.error || (typeof r.data === 'string' ? r.data : JSON.stringify(r.data))).slice(0, 110);

// ---- Manila calendar helpers ----------------------------------------------------------------------------------
const p2 = (n) => String(n).padStart(2, '0');
const manilaDate = (dayOffset) => { const d = new Date(Date.now() + 8 * 3600000 + dayOffset * 86400000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() }; };
const slot = (dayOffset, hour, minutes = 0, durationHours = 1) => {
  const { y, m, d } = manilaDate(dayOffset);
  const iso = (h) => `${y}-${p2(m)}-${p2(d)}T${p2(Math.floor(h))}:${p2(Math.round((h % 1) * 60) + (h === hour ? minutes : 0))}:00+08:00`;
  return { start: iso(hour), end: iso(hour + durationHours), label: `${y}-${p2(m)}-${p2(d)} ${p2(hour)}:${p2(minutes)}` };
};
const nextDow = (dow, minDays = 3) => { for (let i = minDays; i < minDays + 14; i += 1) if (manilaDate(i).dow === dow) return i; return minDays; };
const firstOpenDay = (from = 3, avoid = []) => { for (let i = from; i < from + 14; i += 1) if (manilaDate(i).dow !== 0 && !avoid.includes(i)) return i; return from; };

let refSeq = 0; const runTag = Date.now().toString().slice(-6);
const uniqueRef = () => `LC${runTag}${++refSeq}`;
let plateSeq = 0; const plate = () => `LC${runTag.slice(-3)}${++plateSeq}`;

// ---- setup ----------------------------------------------------------------------------------------------------
const admin = await login('admin@test.local');
const cust = await login('cust@test.local');
const cust2 = await login('soa-customer@test.local');
const staffA = await login('staff@test.local');
const staffB = await login('real-staff@test.local');
const cfgRow = async () => (await json(await rest('business_config?select=*&order=id&limit=1')))[0];
const originalConfig = await cfgRow();
const patchConfig = async (patch) => { const r = await rest(`business_config?id=eq.${originalConfig.id}`, { method: 'PATCH', body: patch }); if (!r.ok) throw new Error('config patch failed ' + (await r.text())); };

const cleanup = async () => {
  const r = await rest('bookings?notes=like.*LIFECYCLE*&select=id');
  const ids = (await json(r)).map((b) => b.id);
  for (let i = 0; i < ids.length; i += 40) {
    const list = ids.slice(i, i + 40).join(',');
    for (const table of ['service_photos', 'payments', 'booking_vehicles']) await rest(`${table}?booking_id=in.(${list})`, { method: 'DELETE' });
    await rest(`audit_logs?booking_id=in.(${list})`, { method: 'DELETE' });
    await rest(`bookings?id=in.(${list})`, { method: 'DELETE' });
  }
  await rest('promo_codes?code=like.LC*', { method: 'DELETE' });
  await rest('blocked_slots?reason=like.*LIFECYCLE*', { method: 'DELETE' });
  return ids.length;
};
console.log('cleaned leftovers:', await cleanup());
await rest(`profiles?id=in.(${staffA.id},${staffB.id})`, { method: 'PATCH', body: { is_clocked_in: true } });
// start from a known promotion list; the original list is restored at the end
await patchConfig({ promo_rules: [] });

const price = async (service, vehicleType) => {
  const r = await rpc('catalog_service_price', { p_name: service, p_vehicle_type: vehicleType }, admin.token);
  return r.ok && r.data !== null ? Number(r.data) : null;
};
const requiredDownpayment = async (total) => Number((await rpc('booking_required_downpayment', { p_total: total }, admin.token)).data);

// ---- the booking helper: builds exactly the payload the wizard sends -------------------------------------------
const bookings = [];
const expectedAudit = []; // { id, label, pattern } checked in phase D
const expectAudit = (rec, label, pattern) => expectedAudit.push({ id: rec.id, label, pattern });
const book = async ({ by = 'customer', kind, day, hour = 10, minutes = 0, hours = null, vehicles, code = null, totalOverride = null, discountedTotal = null, label = '', customer = cust }) => {
  const customerId = customer.id;
  const when = slot(day, hour, minutes, hours || (vehicles.length > 1 ? 2 : 1));
  let total = 0;
  const rpcVehicles = [];
  for (const v of vehicles) {
    const services = [];
    for (const name of v.services) {
      const p = await price(name, v.type);
      if (p === null) return { ok: false, error: `no price for ${name} / ${v.type}` };
      total += p;
      services.push({ service_name: name, price: p, final_price: p });
    }
    rpcVehicles.push({ vehicle: { vehicle_type: v.type, brand: 'Test', model: 'Car', plate_number: v.plate || plate(), status: by === 'admin' ? 'CONFIRMED' : 'SCHEDULED' }, services });
  }
  if (discountedTotal !== null) total = discountedTotal;
  if (totalOverride !== null) total = totalOverride;
  const down = await requiredDownpayment(total);
  const needsDown = down > 0 && down < total;
  let payment = null;
  const ref = uniqueRef();
  if (kind === 'gcash_full' || kind === 'gcash_down') {
    const amount = kind === 'gcash_full' ? total : down;
    // the same server-verified scan session that /api/ocr/verify-receipt creates for a readable receipt
    const session = await json(await rest('ocr_scan_sessions', { method: 'POST', body: { image_hash: `lc-${runTag}-${ref}`, payment_verdict: 'FOR_VERIFICATION', ocr_metadata: { amount, grossAmount: amount, transferFee: 0, referenceNumber: ref, requiredAmount: amount, receipt_url: 'https://example.invalid/receipt.jpg', extraction_unavailable: false } } }));
    payment = { method: 'GCash', payment_type: kind === 'gcash_full' ? 'Full' : 'Downpayment', ocr_scan_id: session[0]?.id, notes: `PAYMENT_DIGITAL|TYPE:${kind}` };
  } else if (kind === 'cash_pending') {
    const amount = needsDown ? down : total;
    payment = { amount, method: 'Cash', payment_type: needsDown ? 'Downpayment' : 'Full', status: 'PENDING', notes: `PAYMENT_CASH|DECLARED_AMOUNT:${amount}` };
  } else if (kind === 'admin_cash_full' || kind === 'admin_cash_down' || kind === 'admin_gcash') {
    const amount = kind === 'admin_cash_down' ? down : total;
    payment = { amount, method: kind === 'admin_gcash' ? 'GCash' : 'Cash', payment_type: kind === 'admin_cash_down' ? 'Downpayment' : 'Full', status: 'PAID', verified_by: admin.id, verified_at: new Date().toISOString(), reference_number: kind === 'admin_gcash' ? ref : null, notes: `ADMIN_CONFIRMED|${kind}` };
  }
  const token = by === 'admin' ? admin.token : customer.token;
  const result = await rpc('create_booking_atomic_secure', { p_payload: {
    booking: {
      customer_id: customerId, customer_name: 'Lifecycle Test', customer_email: 'cust@test.local', contact_number: '09171234567',
      start_datetime: when.start, end_datetime: when.end, status: by === 'admin' ? 'confirmed' : 'scheduled', total_amount: total,
      vehicle_type: vehicles[0].type, promo_code: code, discount_amount_snapshot: 0, notes: `LIFECYCLE ${label}`.trim(),
      service_snapshot: [], service_snapshot_version: 1, is_walk_in: by === 'admin'
    },
    vehicles: rpcVehicles, payment
  } }, token);
  if (!result.ok) return { ok: false, error: message(result), total, down };
  const id = result.data?.booking?.id;
  if (kind === 'receivable') {
    const r = await rpc('admin_record_receivable', { p_booking_id: id, p_note: 'Walk-in: to be received' }, admin.token);
    if (!r.ok) return { ok: false, error: 'receivable: ' + message(r), id };
  }
  const rec = { ok: true, id, total, down, kind, by, day, hour, label, vehicles, whenLabel: when.label };
  bookings.push(rec);
  return rec;
};

const ledger = async (id) => (await rpc('booking_financial_ledger', { p_booking_id: id }, admin.token)).data;
const bookingRow = async (id) => (await json(await rest(`bookings?id=eq.${id}&select=*,booking_vehicles(*),payments(*)`)))[0];
const auditFor = async (id) => json(await rest(`audit_logs?booking_id=eq.${id}&select=action_type,details,actor_role&order=created_at.asc`));

// ---- actions -------------------------------------------------------------------------------------------------------
const verifyAll = async (id, { reject = false } = {}) => {
  if (!id) return [];
  const row = await bookingRow(id);
  const pending = (row.payments || []).filter((p) => ['FOR_VERIFICATION', 'PENDING'].includes(String(p.status).toUpperCase()));
  const out = [];
  for (const p of pending) {
    if (reject) out.push(await rpc('admin_reject_payment', { p_payment_id: p.id, p_booking_id: id, p_reason: 'Stress test: receipt unreadable', p_queue_refund: false, p_refund_note: null }, admin.token));
    else out.push(await rpc('admin_verify_payment', { p_payment_id: p.id, p_booking_id: id, p_verified_amount: Number(p.amount), p_note: 'stress', p_override: false }, admin.token));
  }
  await api('/api/bookings/reconcile-payment-state', { token: admin.token, body: { bookingId: id } });
  return out;
};
const assign = async (id, staff) => {
  const row = await bookingRow(id);
  const r = await rest(`booking_vehicles?booking_id=eq.${id}`, { token: admin.token, method: 'PATCH', body: { staff_id: staff.id } });
  return { ok: r.ok, vehicles: row.booking_vehicles.length, status: r.status, data: r.ok ? null : await json(r) };
};
/** Moves a booking's time to "ten minutes ago" (the local stand-in for the day arriving), then runs the work. */
const timeArrives = async (id) => {
  // the clock is not ours to move, so the start time is set directly in the scratch database (outside the shop-hours triggers)
  try {
    sql(`set session_replication_role = replica; update public.bookings set start_datetime = now() - interval '10 minutes', end_datetime = now() + interval '50 minutes' where id = '${id}'`);
    return true;
  } catch (error) { note(`could not move the time: ${String(error.message).slice(0, 100)}`); return false; }
};
const photo = async (staff, id, vehicleId, phase) => {
  const r = await rest('service_photos', { token: staff.token, method: 'POST', body: { booking_id: id, booking_vehicle_id: vehicleId, phase, storage_path: `lifecycle/${id}/${vehicleId}-${phase}.jpg`, uploaded_by: staff.id } });
  if (!r.ok) {
    const minimal = await rest('service_photos', { token: staff.token, method: 'POST', headers: { Prefer: 'return=minimal' }, body: { booking_id: id, booking_vehicle_id: vehicleId, phase, storage_path: `lifecycle/${id}/${vehicleId}-${phase}-m.jpg`, uploaded_by: staff.id } });
    note(`photo insert refused (${phase}); without returning the row it ${minimal.ok ? 'WORKS' : 'also fails'}`);
    return { ok: minimal.ok, data: minimal.ok ? null : await json(minimal), onlyReturningFailed: minimal.ok };
  }
  return { ok: r.ok, data: r.ok ? null : await json(r) };
};
const doWork = async (id, staff) => {
  const row = await bookingRow(id);
  const steps = [];
  for (const v of row.booking_vehicles) {
    const before = await photo(staff, id, v.id, 'before'); steps.push(['before photo', before.ok, before.ok ? '' : message({ data: before.data })]);
    const start = await api('/api/bookings/update-status', { token: staff.token, body: { bookingId: id, unitId: v.id, newStatus: 'IN_PROGRESS', notes: 'stress', actorName: 'Staff', actorRole: 'STAFF' } });
    steps.push(['start', start.ok, start.ok ? '' : message(start)]);
    if (!start.ok) continue;
    const after = await photo(staff, id, v.id, 'after'); steps.push(['after photo', after.ok, after.ok ? '' : message({ data: after.data })]);
    const finish = await api('/api/bookings/update-status', { token: staff.token, body: { bookingId: id, unitId: v.id, newStatus: 'COMPLETED', notes: 'stress', actorName: 'Staff', actorRole: 'STAFF' } });
    steps.push(['finish', finish.ok, finish.ok ? '' : message(finish)]);
  }
  return steps;
};
const cancel = async (id, by = 'customer', reason = 'Stress test cancellation', customer = cust) => api(by === 'admin' ? '/api/bookings/admin-cancel' : '/api/bookings/cancel', { token: by === 'admin' ? admin.token : customer.token, body: { bookingId: id, reason } });
const reschedule = async (id, day, hour = 11, by = 'admin', customer = cust) => {
  const row = await bookingRow(id);
  const hours = Math.max(1, Math.round((new Date(row.end_datetime) - new Date(row.start_datetime)) / 3600000));
  const when = slot(day, hour, 0, hours);
  return rpc('reschedule_booking', { p_booking_id: id, p_start_datetime: when.start, p_end_datetime: when.end, p_reason: 'Stress test reschedule' }, by === 'admin' ? admin.token : customer.token);
};
const refund = async (id, amount, deduction = 0, method = 'GCash') => rpc('process_booking_refund_v2', { p_booking_id: id, p_refund_amount: amount, p_refund_reason: 'Stress test refund', p_refund_reference: `RFD-LC${runTag}-${++refSeq}`, p_refund_deduction: deduction, p_refund_method: method, p_actor_id: admin.id }, admin.token);

export { };
// =====================================================================================================================
const PHASES = new Set((arg('phases') || 'A,B,C,D,E').split(','));
const T = { admin, cust, cust2, staffA, staffB, rest, json, rpc, api, check, note, section, slot, manilaDate, nextDow, firstOpenDay, book, ledger, bookingRow, auditFor, verifyAll, assign, timeArrives, doWork, cancel, reschedule, refund, message, originalConfig, patchConfig, cfgRow, price, requiredDownpayment, bookings, cleanup, uniqueRef, plate, expectedAudit, expectAudit, sql };
const { runPhases } = await import('./stress-lifecycle-phases.mjs');
let failedHard = null;
try { await runPhases(T, PHASES); } catch (error) { failedHard = error; console.error('\nTest aborted:', error); }

section('Restoring the business configuration and cleaning up');
await rest(`business_config?id=eq.${originalConfig.id}`, { method: 'PATCH', body: Object.fromEntries(Object.entries(originalConfig).filter(([k]) => !['id', 'updated_at'].includes(k))) });
console.log('removed test bookings:', await cleanup());
await rest(`profiles?id=in.(${staffA.id},${staffB.id})`, { method: 'PATCH', body: { is_clocked_in: false } });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} lifecycle checks passed${failedHard ? ' (aborted early)' : ''}`);
process.exit(failed.length || failedHard ? 1 : 0);
