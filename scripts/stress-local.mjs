/**
 * Stress test for the LOCAL scratch stack only (never production).
 *
 *   node scripts/stress-local.mjs --api http://127.0.0.1:55421 --anon <key> --service <key> --backend http://localhost:3999
 *
 * Uses the generated test accounts (admin@test.local, cust@test.local) and tags everything it creates
 * with STRESS so it can be removed again. Refuses any host that is not local.
 */
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), SERVICE = arg('service'), BACKEND = arg('backend') || 'http://localhost:3999';
if (!API || !ANON || !SERVICE) { console.error('Missing --api / --anon / --service'); process.exit(2); }
for (const url of [API, BACKEND]) {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { console.error(`Refusing non-local host ${host}`); process.exit(2); }
}
const PASSWORD = 'LocalTest-123';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const login = async (email) => {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return { token: j.access_token, id: j.user.id };
};
const rest = (path, { token = SERVICE, method = 'GET', body, headers = {} } = {}) =>
  fetch(`${API}/rest/v1/${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers }, body: body ? JSON.stringify(body) : undefined });
const rpc = async (fn, args, token) => { const r = await rest(`rpc/${fn}`, { token, method: 'POST', body: args }); const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { ok: r.ok, status: r.status, json }; };

const day = (offset, hour = 10) => {
  const d = new Date(Date.now() + offset * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return { start: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(hour)}:00:00+08:00`, end: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(hour + 1)}:00:00+08:00` };
};
let plateSeq = 0;
const payload = ({ customerId, when, total = 170, code = null, plate }) => ({
  booking: {
    customer_id: customerId, customer_name: 'Stress Test', customer_email: 'cust@test.local', contact_number: '09171234567',
    start_datetime: when.start, end_datetime: when.end, status: 'scheduled', total_amount: total, vehicle_type: 'Sedan',
    promo_code: code, discount_amount_snapshot: 0, notes: 'STRESS', service_snapshot: [], service_snapshot_version: 1, is_walk_in: false
  },
  vehicles: [{ vehicle: { vehicle_type: 'Sedan', brand: 'Stress', model: 'Car', plate_number: plate || `STR${Date.now() % 100000}${++plateSeq}`, status: 'SCHEDULED' },
    services: [{ service_name: 'Basic Carwash', price: 170, final_price: 170 }] }],
  payment: null
});

const cleanup = async () => {
  await rest('promo_codes?code=like.STRESS*', { method: 'DELETE' });
  const r = await rest('bookings?notes=like.*STRESS*&select=id');
  const ids = (await r.json()).map((b) => b.id);
  for (let i = 0; i < ids.length; i += 50) {
    const list = ids.slice(i, i + 50).join(',');
    await rest(`booking_services?booking_id=in.(${list})`, { method: 'DELETE' });
    await rest(`booking_vehicles?booking_id=in.(${list})`, { method: 'DELETE' });
    await rest(`bookings?id=in.(${list})`, { method: 'DELETE' });
  }
  return ids.length;
};

const cust = await login('cust@test.local');
const admin = await login('admin@test.local');
console.log('signed in; cleaning leftovers:', await cleanup());

// ---- A. many customers fighting for one slot -------------------------------------------------------------
{
  const cfg = (await (await rest('business_config?select=slots_per_hour,enforce_capacity&limit=1')).json())[0];
  const when = day(3, 11);
  const N = 30;
  const started = Date.now();
  const out = await Promise.all(Array.from({ length: N }, () => rpc('create_booking_atomic_secure', { p_payload: payload({ customerId: cust.id, when }) }, cust.token)));
  const ok = out.filter((r) => r.ok).length;
  const serverErrors = out.filter((r) => r.status >= 500).length;
  const msgs = [...new Set(out.filter((r) => !r.ok).map((r) => String(r.json?.message || r.json).slice(0, 70)))];
  const booked = await (await rest(`bookings?notes=like.*STRESS*&start_datetime=eq.${encodeURIComponent(when.start)}&select=id`)).json();
  console.log(`  slot race: ${N} parallel, ${ok} accepted, capacity setting ${cfg.slots_per_hour}, ${Date.now() - started} ms; refusals: ${msgs.join(' | ')}`);
  check('slot race: nobody gets a 5xx', serverErrors === 0, `${serverErrors} server errors`);
  check('slot race: accepted bookings never exceed the shop capacity', ok <= Number(cfg.slots_per_hour), `${ok} accepted vs capacity ${cfg.slots_per_hour}`);
  check('slot race: database agrees with the answers given', booked.length === ok, `${booked.length} rows vs ${ok} accepted`);
}

// ---- B. promo code with a use limit ------------------------------------------------------------------------
{
  await rest('promo_codes', { method: 'POST', body: { code: 'STRESSLIMIT', name: 'Stress limit', discount_type: 'percentage', discount_value: 10, max_uses: 3 } });
  const N = 20;
  const out = await Promise.all(Array.from({ length: N }, (_, i) => rpc('create_booking_atomic_secure', { p_payload: payload({ customerId: cust.id, when: day(5 + i, 9), total: 153, code: 'STRESSLIMIT' }) }, cust.token)));
  const ok = out.filter((r) => r.ok).length;
  const row = (await (await rest('promo_codes?code=eq.STRESSLIMIT&select=uses_count')).json())[0];
  console.log(`  promo limit: ${N} parallel bookings, ${ok} accepted, uses_count ${row?.uses_count}`);
  check('promo limit: exactly the allowed number of uses succeed', ok === 3, `${ok} accepted`);
  check('promo limit: the counter matches', Number(row?.uses_count) === ok, `uses_count ${row?.uses_count}`);
}

// ---- C. tampered totals --------------------------------------------------------------------------------------
{
  const N = 40;
  const out = await Promise.all(Array.from({ length: N }, (_, i) => rpc('create_booking_atomic_secure', { p_payload: payload({ customerId: cust.id, when: day(8 + (i % 20), 14), total: 1 }) }, cust.token)));
  check('tampered total (₱1 for a ₱170 service) is refused every time', out.every((r) => !r.ok && /does not match/i.test(JSON.stringify(r.json))), `${out.filter((r) => r.ok).length} slipped through`);
  const over = await Promise.all(Array.from({ length: 10 }, (_, i) => rpc('create_booking_atomic_secure', { p_payload: payload({ customerId: cust.id, when: day(9, 15), total: 99999 }) }, cust.token)));
  check('inflated total is refused', over.every((r) => !r.ok), `${over.filter((r) => r.ok).length} slipped through`);
}

// ---- D. admin creates many promos at once (read-modify-write on one row) ----------------------------------
{
  const before = (await (await rest('business_config?select=promo_rules&limit=1')).json())[0].promo_rules || [];
  const N = 12;
  const out = await Promise.all(Array.from({ length: N }, (_, i) => fetch(`${BACKEND}/api/admin/promos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ name: `STRESS promo ${i}`, mode: 'standard', type: 'percentage', value: 5, validFrom: '2026-10-01', neverExpires: true, vehicleTypes: ['Sedan'], vehicleServiceMatrix: { Sedan: ['Basic Carwash'] } })
  })));
  const accepted = out.filter((r) => r.ok).length;
  const after = (await (await rest('business_config?select=promo_rules&limit=1')).json())[0].promo_rules || [];
  const stored = after.filter((r) => String(r.name).startsWith('STRESS promo')).length;
  console.log(`  promo writes: ${N} parallel, ${accepted} answered success, ${stored} actually stored`);
  check('parallel promo creation: every promo that was reported saved is stored', stored === accepted, `${accepted} reported vs ${stored} stored (lost ${accepted - stored})`);
  // put the promo list back the way it was
  await rest('business_config?id=gt.0', { method: 'PATCH', body: { promo_rules: before } });
}

// ---- E. read load ---------------------------------------------------------------------------------------------
{
  const run = async (label, n, fn) => {
    const times = [];
    let failed = 0;
    const t0 = Date.now();
    // 40 requests in flight at a time, like a busy shop; thousands of sockets opened at once only test this laptop
    let next = 0;
    const worker = async () => { while (next < n) { next += 1; const s = Date.now(); try { const r = await fn(); if (!r.ok) failed += 1; await r.arrayBuffer?.(); } catch { failed += 1; } times.push(Date.now() - s); } };
    await Promise.all(Array.from({ length: 40 }, worker));
    const total = Date.now() - t0;
    console.log(`  ${label}: ${n} requests in ${total} ms (${Math.round(n / (total / 1000))}/s), p50 ${pct(times, .5)} ms, p95 ${pct(times, .95)} ms, max ${Math.max(...times)} ms, failed ${failed}`);
    return { failed, p95: pct(times, .95) };
  };
  const a = await run('shop config (public read)', 300, () => rest('business_config?select=*&limit=1', { token: ANON }));
  const b = await run('my bookings (customer)', 150, () => rest('bookings?select=*,booking_vehicles(*),payments(*)&order=created_at.desc&limit=50', { token: cust.token }));
  const c = await run('admin booking list', 150, () => rest('bookings?select=*,booking_vehicles(*),payments(*)&order=created_at.desc&limit=100', { token: admin.token }));
  const d = await run('ledger view (admin)', 100, () => rest('booking_ledger_v?select=*&limit=100', { token: admin.token }));
  check('read load: no failed requests', a.failed + b.failed + c.failed + d.failed === 0, `${a.failed + b.failed + c.failed + d.failed} failed`);
  check('read load: p95 under 3 seconds', Math.max(a.p95, b.p95, c.p95, d.p95) < 3000, `worst p95 ${Math.max(a.p95, b.p95, c.p95, d.p95)} ms`);
}

// ---- F. backend hammering -------------------------------------------------------------------------------------
{
  const statuses = {};
  await Promise.all(Array.from({ length: 150 }, async (_, i) => {
    const r = await fetch(`${BACKEND}/api/admin/promos`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: i % 2 ? `Bearer ${cust.token}` : 'Bearer garbage' }, body: '{}' });
    statuses[r.status] = (statuses[r.status] || 0) + 1;
  }));
  console.log('  unauthorised admin calls:', JSON.stringify(statuses));
  check('unauthorised admin calls are all refused (401/403/429)', Object.keys(statuses).every((s) => ['401', '403', '429'].includes(s)), JSON.stringify(statuses));
  const junk = await fetch(`${BACKEND}/api/admin/promos`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` }, body: '{not json' });
  check('malformed JSON gets a 4xx, not a crash', junk.status >= 400 && junk.status < 500, `status ${junk.status}`);
  const alive = await fetch(`${BACKEND}/`);
  check('backend is still answering afterwards', alive.status > 0);
}

console.log('cleaned up test bookings:', await cleanup());
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} stress checks passed`);
process.exit(failed.length ? 1 : 0);
