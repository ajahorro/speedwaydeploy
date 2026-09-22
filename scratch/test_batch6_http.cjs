// Batch 6 / Step 6.2 — HTTP-layer integration test.
//
// Boots the REAL backend/server.js (so the actual Express routes are exercised)
// but replaces the @supabase/supabase-js client with an in-memory fake BEFORE
// server.js is required. That means: no live DB, deterministic data, and a true
// end-to-end check of status codes + JSON envelopes over HTTP.
const path = require('path');
const Module = require('module');
const http = require('http');

// Capture the Express server instance so we can close it cleanly at the end.
// Calling process.exit() with the listen handle still open trips a libuv
// teardown assertion on Windows (UV_HANDLE_CLOSING), which would otherwise make
// this harness report a false failure to the master sweep.
let capturedServer = null;
const realListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  capturedServer = this;
  return realListen.apply(this, args);
};

// server.js schedules a long-lived background interval (the overdue-bookings
// watchdog, every 5 min). That handle keeps libuv alive and its teardown is what
// triggers the Windows assertion above. Capture created intervals so we can
// clear them before exiting — without modifying production code.
const createdIntervals = [];
const realSetInterval = global.setInterval;
global.setInterval = (...args) => {
  const id = realSetInterval.apply(global, args);
  createdIntervals.push(id);
  return id;
};

// ─── In-memory fake data ─────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const TOMORROW = key(addDays(1));
const PAST = key(addDays(-2));
const SUNDAY = (() => { for (let n = 1; n < 15; n++) if (addDays(n).getDay() === 0) return key(addDays(n)); return null; })();

const TABLES = {
  business_config: [{
    id: 1, opening_hour: '07:00 AM', closing_hour: '09:00 PM',
    slots_per_hour: 2, max_vehicles_per_staff: 4,
    booking_lead_time_minutes: 120, max_advance_days: 30,
    closed_weekdays: [0], enforce_capacity: true,
  }],
  blocked_slots: [
    { id: 'blk1', block_date: key(addDays(3)), start_time: null, end_time: null, reason: 'HOLIDAY' },
  ],
  bookings: [],
  profiles: [],
};

function makeFakeClient() {
  const from = (table) => {
    const filters = [];
    const rows = () => (TABLES[table] || []).filter((row) =>
      filters.every(([col, val]) => Array.isArray(val) ? val.includes(row[col]) : row[col] === val));
    const b = {
      select(_c, opts = {}) { b._head = Boolean(opts.head); return b; },
      eq(c, v) { filters.push([c, v]); return b; },
      in(c, v) { filters.push([c, v]); return b; },
      lte() { return b; }, gte() { return b; }, lt() { return b; }, gt() { return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then(res) { return res({ data: b._head ? null : rows(), error: null, count: rows().length }); },
    };
    return b;
  };
  return {
    from,
    auth: {
      getUser: async () => ({ data: { user: null } }),
      admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
    },
  };
}

// ─── Stub require('@supabase/supabase-js') before server.js loads ────────────

const fakeClient = makeFakeClient();
const supabasePath = require.resolve('@supabase/supabase-js', { paths: [path.join(__dirname, '../backend')] });
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { createClient: () => fakeClient },
};

// Ensure the server finds credentials so supabaseAdmin is initialised.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://fake.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fake-service-role-key';
process.env.PORT = process.env.PORT || '3299';
process.env.RESEND_API_KEY = '';

const PORT = process.env.PORT;
const BASE = `http://127.0.0.1:${PORT}`;

// Load the real server (starts listening).
require('../backend/server.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ''}`); }
};

const post = async (body) => {
  const res = await fetch(`${BASE}/api/bookings/validate-slot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

(async () => {
  // Give the server a beat to bind.
  await new Promise((r) => setTimeout(r, 1200));

  console.log('=== HTTP: POST /api/bookings/validate-slot ===');

  const okRes = await post({ date: TOMORROW, time: '11:00' });
  check('valid slot -> 200 / valid:true / code OK',
    okRes.status === 200 && okRes.json.valid === true && okRes.json.code === 'OK',
    `${okRes.status} ${JSON.stringify(okRes.json)}`);

  const pastRes = await post({ date: PAST, time: '11:00' });
  check('past date -> 400 / code PAST_DATE',
    pastRes.status === 400 && pastRes.json.code === 'PAST_DATE',
    `${pastRes.status} ${JSON.stringify(pastRes.json)}`);

  const badDateRes = await post({ date: 'nope', time: '11:00' });
  check('malformed date -> 400 / code INVALID_DATE',
    badDateRes.status === 400 && badDateRes.json.code === 'INVALID_DATE',
    `${badDateRes.status} ${JSON.stringify(badDateRes.json)}`);

  const badTimeRes = await post({ date: TOMORROW, time: 'xx' });
  check('malformed time -> 400 / code INVALID_SLOT',
    badTimeRes.status === 400 && badTimeRes.json.code === 'INVALID_SLOT',
    `${badTimeRes.status} ${JSON.stringify(badTimeRes.json)}`);

  if (SUNDAY) {
    const sunRes = await post({ date: SUNDAY, time: '11:00' });
    check('closed Sunday -> 409 / code CLOSED_WEEKDAY',
      sunRes.status === 409 && sunRes.json.code === 'CLOSED_WEEKDAY',
      `${sunRes.status} ${JSON.stringify(sunRes.json)}`);
  }

  const blockedRes = await post({ date: key(addDays(3)), time: '11:00' });
  check('whole-day block -> 409 / code BLOCKED_DATE',
    blockedRes.status === 409 && blockedRes.json.code === 'BLOCKED_DATE',
    `${blockedRes.status} ${JSON.stringify(blockedRes.json)}`);

  const farRes = await post({ date: key(addDays(45)), time: '11:00' });
  check('+45 days -> 409 / code BEYOND_ADVANCE_WINDOW',
    farRes.status === 409 && farRes.json.code === 'BEYOND_ADVANCE_WINDOW',
    `${farRes.status} ${JSON.stringify(farRes.json)}`);

  // Capacity: fill tomorrow 11:00 by mutating the fake tables mid-run.
  TABLES.bookings.push(
    { id: 'b1', status: 'confirmed', start_datetime: `${TOMORROW}T11:00:00`, end_datetime: `${TOMORROW}T12:00:00`, vehicles: [{ vehicle_type: 'Sedan' }] },
    { id: 'b2', status: 'confirmed', start_datetime: `${TOMORROW}T11:00:00`, end_datetime: `${TOMORROW}T12:00:00`, vehicles: [{ vehicle_type: 'SUV' }] },
  );
  const capRes = await post({ date: TOMORROW, time: '11:00' });
  check('full slot -> 409 / code CAPACITY_EXCEEDED',
    capRes.status === 409 && capRes.json.code === 'CAPACITY_EXCEEDED',
    `${capRes.status} ${JSON.stringify(capRes.json)}`);

  // Error envelope shape consistency.
  check('error envelope has success/valid/code/message fields',
    capRes.json.success === false && capRes.json.valid === false &&
    typeof capRes.json.code === 'string' && typeof capRes.json.message === 'string');

  console.log('=== HTTP: GET /api/bookings/slots ===');
  const slotsRes = await fetch(`${BASE}/api/bookings/slots?date=${TOMORROW}&durationMinutes=60`);
  const slotsJson = await slotsRes.json();
  check('slots endpoint -> 200 / array returned',
    slotsRes.status === 200 && Array.isArray(slotsJson.slots),
    `${slotsRes.status} ${JSON.stringify(slotsJson).slice(0, 120)}`);

  const badSlotsRes = await fetch(`${BASE}/api/bookings/slots?date=bad`);
  check('slots endpoint bad date -> 400',
    badSlotsRes.status === 400, `${badSlotsRes.status}`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  // Clear background intervals and close the server WITHOUT calling
  // process.exit(): on Windows, forcing exit while libuv still holds an async
  // handle trips an assertion in win/async.c. Setting exitCode and letting the
  // loop drain naturally is the reliable path.
  for (const id of createdIntervals) { try { clearInterval(id); } catch { /* ignore */ } }
  process.exitCode = fail === 0 ? 0 : 1;
  if (capturedServer && capturedServer.listening) {
    capturedServer.closeAllConnections?.();
    capturedServer.close();
  }
  // If any stray handle keeps us alive, unref it by forcing GC of the loop.
  process.unref?.();
})().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exitCode = 1;
});
