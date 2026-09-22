// Batch 6 / Step 6.2 — exercise the server-side schedule validator directly.
//
// We drive `validateBookingRequest` against an in-memory fake Supabase client
// so the full code path (config load -> date gate -> slot gate -> capacity)
// runs deterministically with no network and no live DB.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  validateBookingRequest,
  parseTimeOfDay,
  normalizeRequest,
} = require('../backend/services/scheduleValidation.js');

// ─── Minimal fake Supabase query builder ─────────────────────────────────────

function makeFakeSupabase(tables) {
  const from = (table) => {
    const state = { table, filters: [], head: false, count: false };
    const rowsFor = () =>
      (tables[table] || []).filter((row) =>
        state.filters.every(([col, val]) => {
          if (Array.isArray(val)) return val.includes(row[col]);
          return row[col] === val;
        })
      );

    const builder = {
      select(_cols, opts = {}) {
        state.head = Boolean(opts.head);
        state.count = Boolean(opts.count);
        return builder;
      },
      eq(col, val) { state.filters.push([col, val]); return builder; },
      in(col, vals) { state.filters.push([col, vals]); return builder; },
      lte() { return builder; },
      gte() { return builder; },
      lt() { return builder; },
      gt() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return Promise.resolve({ data: rowsFor()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rowsFor()[0] ?? null, error: null }); },
      then(resolve) {
        const rows = rowsFor();
        if (state.head) return resolve({ data: null, error: null, count: rows.length });
        return resolve({ data: rows, error: null });
      },
    };
    return builder;
  };
  return { from };
}

// ─── Date helpers (relative to "today" so tests never rot) ───────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const TODAY = key(addDays(0));
const TOMORROW = key(addDays(1));
const PAST = key(addDays(-2));
// Find a date within the advance window that lies on a Friday (weekday 5).
function nextWeekday(target, minDaysAhead = 2) {
  for (let n = minDaysAhead; n < minDaysAhead + 14; n++) {
    if (addDays(n).getDay() === target) return key(addDays(n));
  }
  return null;
}
const NEXT_SUNDAY = nextWeekday(0, 1);
const NEXT_FRIDAY = nextWeekday(5, 2);

// Business config used across the suite: open 07:00-21:00, closed Sundays,
// 2 bays/hour, 4 vehicles/staff, 120-min lead time, 30-day advance window.
const CONFIG = {
  opening_hour: '07:00 AM',
  closing_hour: '09:00 PM',
  slots_per_hour: 2,
  max_vehicles_per_staff: 4,
  booking_lead_time_minutes: 120,
  max_advance_days: 30,
  closed_weekdays: [0],
  enforce_capacity: true,
};

// A far-future in-hours slot that is always past the 120-min lead time.
const OPEN_TIME = '11:00';

function baseTables(overrides = {}) {
  return {
    business_config: [{ ...CONFIG }],
    blocked_slots: [],
    bookings: [],
    profiles: [], // staffOnDuty -> falls back to 1
    ...overrides,
  };
}

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ''}`); }
};

(async () => {
  // ── parseTimeOfDay / normalizeRequest unit checks ─────────────────────────
  console.log('=== request parsing ===');
  check("parseTimeOfDay('11:00') -> 11:00", JSON.stringify(parseTimeOfDay('11:00')) === '{"hour":11,"minute":0}');
  check("parseTimeOfDay('2:30 PM') -> 14:30", JSON.stringify(parseTimeOfDay('2:30 PM')) === '{"hour":14,"minute":30}');
  check("parseTimeOfDay('garbage') -> null", parseTimeOfDay('garbage') === null);
  const nr = normalizeRequest({ date: '2026-01-05T09:00:00Z', time: '11:00', durationMinutes: 90, requestedBays: 2 });
  check('normalizeRequest slices date + parses fields', nr.dateStr === '2026-01-05' && nr.durationMinutes === 90 && nr.requestedBays === 2);

  // ── VALID booking ─────────────────────────────────────────────────────────
  console.log('\n=== valid slot ===');
  const okRes = await validateBookingRequest(
    makeFakeSupabase(baseTables()),
    { date: TOMORROW, time: OPEN_TIME, durationMinutes: 60 }
  );
  check('valid request -> valid:true / code OK / status 200',
    okRes.valid === true && okRes.code === 'OK' && okRes.status === 200,
    JSON.stringify(okRes));

  // ── PAST_DATE (400) ───────────────────────────────────────────────────────
  console.log('\n=== violations ===');
  const pastRes = await validateBookingRequest(makeFakeSupabase(baseTables()), { date: PAST, time: OPEN_TIME });
  check('past date -> 400 PAST_DATE',
    pastRes.valid === false && pastRes.status === 400 && pastRes.code === 'PAST_DATE', JSON.stringify(pastRes));

  // ── CLOSED_WEEKDAY (409) ──────────────────────────────────────────────────
  if (NEXT_SUNDAY) {
    const sunRes = await validateBookingRequest(makeFakeSupabase(baseTables()), { date: NEXT_SUNDAY, time: OPEN_TIME });
    check('closed Sunday -> 409 CLOSED_WEEKDAY',
      sunRes.valid === false && sunRes.status === 409 && sunRes.code === 'CLOSED_WEEKDAY', JSON.stringify(sunRes));
  } else {
    check('closed Sunday -> 409 CLOSED_WEEKDAY (SKIPPED: no Sunday found)', false);
  }

  // ── BLOCKED_DATE (409) — whole-day admin block ─────────────────────────────
  const blockedRes = await validateBookingRequest(
    makeFakeSupabase(baseTables({
      blocked_slots: [{ id: 'blk1', block_date: NEXT_FRIDAY, start_time: null, end_time: null, reason: 'HOLIDAY' }],
    })),
    { date: NEXT_FRIDAY, time: OPEN_TIME }
  );
  check('whole-day block -> 409 BLOCKED_DATE',
    blockedRes.valid === false && blockedRes.status === 409 && blockedRes.code === 'BLOCKED_DATE', JSON.stringify(blockedRes));

  // ── SLOT_UNAVAILABLE (409) — partial-time block over the slot ──────────────
  const partialRes = await validateBookingRequest(
    makeFakeSupabase(baseTables({
      blocked_slots: [{ id: 'blk2', block_date: NEXT_FRIDAY, start_time: '10:00', end_time: '12:00', reason: 'MAINTENANCE' }],
    })),
    { date: NEXT_FRIDAY, time: OPEN_TIME } // 11:00 falls inside 10:00-12:00
  );
  check('partial block over slot -> 409 SLOT_UNAVAILABLE',
    partialRes.valid === false && partialRes.status === 409 && partialRes.code === 'SLOT_UNAVAILABLE', JSON.stringify(partialRes));

  // ── BEYOND_ADVANCE_WINDOW (409) ───────────────────────────────────────────
  const farRes = await validateBookingRequest(makeFakeSupabase(baseTables()), { date: key(addDays(45)), time: OPEN_TIME });
  check('+45 days -> 409 BEYOND_ADVANCE_WINDOW',
    farRes.valid === false && farRes.status === 409 && farRes.code === 'BEYOND_ADVANCE_WINDOW', JSON.stringify(farRes));

  // ── LEAD_TIME (409) — booking today but only 30 min out ────────────────────
  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 60 * 1000);
  // Only run when the 30-min-out slot still lands on the same calendar day and
  // inside operating hours (07:00-21:00); otherwise skip gracefully.
  if (soon.getDate() === now.getDate() && soon.getHours() >= 7 && soon.getHours() < 20) {
    const leadRes = await validateBookingRequest(
      makeFakeSupabase(baseTables()),
      { date: TODAY, time: `${pad2(soon.getHours())}:${pad2(soon.getMinutes())}` }
    );
    check('30 min out today -> 409 LEAD_TIME',
      leadRes.valid === false && leadRes.status === 409 && leadRes.code === 'LEAD_TIME', JSON.stringify(leadRes));
  } else {
    console.log('SKIP  LEAD_TIME wall-clock check (outside same-day window)');
  }

  // ── CAPACITY_EXCEEDED (409) — two full-bay bookings fill a 2-bay slot ──────
  const fullDay = [
    { id: 'b1', status: 'confirmed', start_datetime: `${TOMORROW}T11:00:00`, end_datetime: `${TOMORROW}T12:00:00`, vehicles: [{ vehicle_type: 'Sedan', status: 'SCHEDULED' }] },
    { id: 'b2', status: 'confirmed', start_datetime: `${TOMORROW}T11:00:00`, end_datetime: `${TOMORROW}T12:00:00`, vehicles: [{ vehicle_type: 'SUV', status: 'SCHEDULED' }] },
  ];
  const capRes = await validateBookingRequest(
    makeFakeSupabase(baseTables({ bookings: fullDay })),
    { date: TOMORROW, time: OPEN_TIME }
  );
  check('full slot -> 409 CAPACITY_EXCEEDED',
    capRes.valid === false && capRes.status === 409 && capRes.code === 'CAPACITY_EXCEEDED', JSON.stringify(capRes));

  // ── Capacity respects cancelled bookings (slot frees up) ──────────────────
  const cancelledDay = [
    { ...fullDay[0], status: 'CANCELLED' },
    { ...fullDay[1], status: 'cancelled' },
  ];
  const freedRes = await validateBookingRequest(
    makeFakeSupabase(baseTables({ bookings: cancelledDay })),
    { date: TOMORROW, time: OPEN_TIME }
  );
  check('cancelled bookings free the slot (valid)',
    freedRes.valid === true, JSON.stringify(freedRes));

  // ── enforce_capacity=false bypasses CAPACITY_EXCEEDED ─────────────────────
  const noCapRes = await validateBookingRequest(
    makeFakeSupabase(baseTables({ business_config: [{ ...CONFIG, enforce_capacity: false }], bookings: fullDay })),
    { date: TOMORROW, time: OPEN_TIME }
  );
  check('enforce_capacity=false -> slot valid despite full bookings',
    noCapRes.valid === true, JSON.stringify(noCapRes));

  // ── Malformed requests (400) ──────────────────────────────────────────────
  const badDateRes = await validateBookingRequest(makeFakeSupabase(baseTables()), { date: 'nope', time: OPEN_TIME });
  check('missing/garbage date -> 400 INVALID_DATE',
    badDateRes.valid === false && badDateRes.status === 400 && badDateRes.code === 'INVALID_DATE', JSON.stringify(badDateRes));

  const badTimeRes = await validateBookingRequest(makeFakeSupabase(baseTables()), { date: TOMORROW, time: 'not-a-time' });
  check('missing/garbage time -> 400 INVALID_SLOT',
    badTimeRes.valid === false && badTimeRes.status === 400 && badTimeRes.code === 'INVALID_SLOT', JSON.stringify(badTimeRes));

  // ── Fail-closed: a DB error must NOT report valid ────────────────────────
  const brokenDb = { from: () => ({ select: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }) };
  let threw = false;
  try { await validateBookingRequest(brokenDb, { date: TOMORROW, time: OPEN_TIME }); }
  catch { threw = true; }
  check('DB error surfaces as a throw (endpoint maps to 500, never silent pass)', threw);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
