// Batch 6 / Step 6.1 — unit assertions for the pure schedule rules module.
//
// The module is pure ESM with no React/Supabase imports, so we can import it
// directly from Node (frontend/package.json has "type": "module").
import {
  isDateBookable,
  isSlotBookable,
  getBookableSlots,
  normalizeConfig,
  dateKey,
  SCHEDULE_DEFAULTS,
  SCHEDULE_DECISION_CODES as CODE,
} from '../frontend/src/domain/schedule/rules.js';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ''}`); }
};
const codesMatch = (r, code) => r && r.bookable === false && r.code === code;

// Fixed "now": Wednesday 2026-06-10 09:00 local, so weekday math is stable.
const NOW = new Date(2026, 5, 10, 9, 0, 0);
const CONFIG = {
  booking_lead_time_minutes: 120,
  max_advance_days: 30,
  closed_weekdays: [0],          // closed Sundays
  enforce_capacity: true,
  slots_per_hour: 2,
  max_vehicles_per_staff: 4,
  opening_hour: 7,
  closing_hour: 21,
};

console.log('=== isDateBookable ===');

// Today is bookable (not a past date; Wed not closed).
check('today is bookable', isDateBookable('2026-06-10', CONFIG, { now: NOW }).bookable);

// Past date rejected.
check('yesterday (2026-06-09) -> PAST_DATE',
  codesMatch(isDateBookable('2026-06-09', CONFIG, { now: NOW }), CODE.PAST_DATE));

// Sunday (2026-06-14) is a closed weekday.
check('Sunday 2026-06-14 -> CLOSED_WEEKDAY',
  codesMatch(isDateBookable('2026-06-14', CONFIG, { now: NOW }), CODE.CLOSED_WEEKDAY));

// Beyond the advance window: 2026-06-10 + 31 days = 2026-07-11.
check('+31 days -> BEYOND_ADVANCE_WINDOW',
  codesMatch(isDateBookable('2026-07-11', CONFIG, { now: NOW }), CODE.BEYOND_ADVANCE_WINDOW));

// Boundary: exactly +30 days (2026-07-10) is allowed (inclusive).
check('+30 days (boundary) is bookable',
  isDateBookable('2026-07-10', CONFIG, { now: NOW }).bookable);

// Whole-day admin block -> BLOCKED_DATE.
check('whole-day block -> BLOCKED_DATE',
  codesMatch(
    isDateBookable('2026-06-12', CONFIG, { now: NOW, blocks: [{ block_date: '2026-06-12', start_time: null, end_time: null }] }),
    CODE.BLOCKED_DATE));

// PARTIAL block must NOT close the whole date.
check('partial-time block does not close the date',
  isDateBookable('2026-06-12', CONFIG, {
    now: NOW, blocks: [{ block_date: '2026-06-12', start_time: '12:00', end_time: '14:00' }],
  }).bookable);

// Garbage date.
check('garbage date -> INVALID_DATE',
  codesMatch(isDateBookable('not-a-date', CONFIG, { now: NOW }), CODE.INVALID_DATE));

// Empty config (no row yet) falls back to defaults and does not block everything.
check('empty config uses safe defaults (today bookable)',
  isDateBookable('2026-06-10', {}, { now: NOW }).bookable);

console.log('\n=== isSlotBookable ===');

// A slot 3 hours out is fine (lead time 120 min).
check('11:00 today is bookable',
  isSlotBookable('2026-06-10', { hour: 11, minute: 0 }, CONFIG, [], { now: NOW }).bookable);

// A slot only 1 hour out violates the 120-minute lead time.
check('10:00 today (1h away) -> LEAD_TIME',
  codesMatch(isSlotBookable('2026-06-10', { hour: 10, minute: 0 }, CONFIG, [], { now: NOW }), CODE.LEAD_TIME));

// Slot that would run past closing (20:30 + 60m > 21:00).
check('20:30 + 60m -> SLOT_BLOCKED (past closing)',
  codesMatch(isSlotBookable('2026-06-10', { hour: 20, minute: 30 }, CONFIG, [], { now: NOW }), CODE.SLOT_BLOCKED));

// Partial block over the requested window.
check('slot inside a partial block -> SLOT_BLOCKED',
  codesMatch(
    isSlotBookable('2026-06-10', { hour: 13, minute: 0 }, CONFIG, [], {
      now: NOW, blocks: [{ block_date: '2026-06-10', start_time: '12:00', end_time: '14:00' }],
    }),
    CODE.SLOT_BLOCKED));

// Capacity: slots_per_hour = 2. Two overlapping bookings fill the bay ceiling.
const twoFull = [
  { id: 'b1', status: 'confirmed', start_datetime: '2026-06-10T11:00:00', end_datetime: '2026-06-10T12:00:00', vehicles: [{ vehicle_type: 'Sedan' }] },
  { id: 'b2', status: 'confirmed', start_datetime: '2026-06-10T11:00:00', end_datetime: '2026-06-10T12:00:00', vehicles: [{ vehicle_type: 'SUV' }] },
];
check('full slot -> SLOT_FULL',
  codesMatch(isSlotBookable('2026-06-10', { hour: 11, minute: 0 }, CONFIG, twoFull, { now: NOW }), CODE.SLOT_FULL));

// One overlapping booking leaves remaining = 1.
const oneUsed = [twoFull[0]];
const slotOneUsed = isSlotBookable('2026-06-10', { hour: 11, minute: 0 }, CONFIG, oneUsed, { now: NOW });
check('one booking used -> bookable with remaining 1',
  slotOneUsed.bookable === true && slotOneUsed.remaining === 1);

// Cancelled bookings do NOT consume capacity.
const cancelled = [{ ...twoFull[0], status: 'CANCELLED' }, { ...twoFull[1], status: 'cancelled' }];
check('cancelled bookings free the slot',
  isSlotBookable('2026-06-10', { hour: 11, minute: 0 }, CONFIG, cancelled, { now: NOW }).bookable);

// Non-overlapping booking does not consume this slot.
const later = [{ id: 'b3', status: 'confirmed', start_datetime: '2026-06-10T15:00:00', end_datetime: '2026-06-10T16:00:00', vehicles: [{ vehicle_type: 'Sedan' }] }];
check('non-overlapping booking does not block 11:00',
  isSlotBookable('2026-06-10', { hour: 11, minute: 0 }, CONFIG, later, { now: NOW }).bookable);

// Bikes share bays: 2 bikes = 1 bay, so slots_per_hour 2 can take 4 bikes.
const fourBikes = [1, 2, 3, 4].map((n) => ({
  id: `bk${n}`, status: 'confirmed',
  start_datetime: '2026-06-10T11:00:00', end_datetime: '2026-06-10T12:00:00',
  vehicles: [{ vehicle_type: 'Regular' }],
}));
const bikeResult = isSlotBookable('2026-06-10', { hour: 11, minute: 0 }, CONFIG, fourBikes, { now: NOW });
check('4 bikes = 2 bays fills a slots_per_hour=2 slot',
  codesMatch(bikeResult, CODE.SLOT_FULL));

// enforce_capacity = false bypasses the full-slot block.
const noCap = { ...CONFIG, enforce_capacity: false };
check('enforce_capacity=false bypasses SLOT_FULL',
  isSlotBookable('2026-06-10', { hour: 11, minute: 0 }, noCap, twoFull, { now: NOW }).bookable);

// Per-staff ceiling: 2 staff * max_vehicles_per_staff 1 = 2 vehicles even if bays allow more.
const perStaff = { ...CONFIG, slots_per_hour: 10, max_vehicles_per_staff: 1 };
check('per-staff ceiling (2 staff x 1) caps capacity at 2',
  codesMatch(isSlotBookable('2026-06-10', { hour: 11, minute: 0 }, perStaff, twoFull, { now: NOW, staffOnDuty: 2 }), CODE.SLOT_FULL));

// Slot re-checks the date gate.
check('slot on a past date -> PAST_DATE',
  codesMatch(isSlotBookable('2026-06-09', { hour: 11, minute: 0 }, CONFIG, [], { now: NOW }), CODE.PAST_DATE));

console.log('\n=== getBookableSlots ===');

const allSlots = getBookableSlots('2026-06-10', CONFIG, [], { now: NOW });
// Shop 07:00–21:00 at 30-min granularity would be 28 start slots, but the last
// (20:30) cannot fit the default 60-min service before closing, so 27 remain.
// Of those, the 07:00..10:30 slots (8) are dropped by the 120-min lead time
// at 09:00 today => 19 bookable slots.
check(`today yields 19 slots (27 - 8 dropped by lead time), got ${allSlots.length}`, allSlots.length === 19);
check('first bookable slot today is 11:00', allSlots[0] && allSlots[0].hour === 11 && allSlots[0].minute === 0);
check('last bookable slot today is 20:00 (20:30 would run past closing)',
  allSlots[allSlots.length - 1].hour === 20 && allSlots[allSlots.length - 1].minute === 0);
check('each slot reports remaining capacity', allSlots.every(s => typeof s.remaining === 'number'));

const futureSlots = getBookableSlots('2026-06-11', CONFIG, [], { now: NOW });
check(`a future day yields 27 slots (28 minus the past-closing 20:30), got ${futureSlots.length}`, futureSlots.length === 27);

check('closed weekday yields no slots', getBookableSlots('2026-06-14', CONFIG, [], { now: NOW }).length === 0);
check('past date yields no slots', getBookableSlots('2026-06-09', CONFIG, [], { now: NOW }).length === 0);

// Full midday slot drops out of the enumeration.
const busyDay = [
  { id: 'x1', status: 'confirmed', start_datetime: '2026-06-11T11:00:00', end_datetime: '2026-06-11T12:00:00', vehicles: [{ vehicle_type: 'Sedan' }] },
  { id: 'x2', status: 'confirmed', start_datetime: '2026-06-11T11:00:00', end_datetime: '2026-06-11T12:00:00', vehicles: [{ vehicle_type: 'Sedan' }] },
];
const busySlots = getBookableSlots('2026-06-11', CONFIG, busyDay, { now: NOW });
check('fully-booked 11:00 slot is excluded from enumeration',
  !busySlots.some(s => s.hour === 11 && s.minute === 0));
check('partially-booked 11:00 still has capacity (remaining 1 elsewhere)',
  busySlots.every(s => s.remaining >= 1));

console.log('\n=== helpers ===');

check('normalizeConfig clamps negatives to safe values', (() => {
  const c = normalizeConfig({ booking_lead_time_minutes: -5, max_advance_days: 0, slots_per_hour: -2 });
  return c.booking_lead_time_minutes === 0 && c.max_advance_days === 1 && c.slots_per_hour === 1;
})());

check('normalizeConfig filters invalid weekday numbers', (() => {
  const c = normalizeConfig({ closed_weekdays: [0, 9, -1, 3, 'x'] });
  return c.closed_weekdays.length === 2 && c.closed_weekdays.includes(0) && c.closed_weekdays.includes(3);
})());

check('enforce_capacity defaults to true when omitted',
  normalizeConfig({}).enforce_capacity === true);

check('dateKey formats a Date as local YYYY-MM-DD',
  dateKey(new Date(2026, 0, 5)) === '2026-01-05');

check('SCHEDULE_DEFAULTS mirrors the SQL defaults (120/30/[])',
  SCHEDULE_DEFAULTS.booking_lead_time_minutes === 120 &&
  SCHEDULE_DEFAULTS.max_advance_days === 30 &&
  Array.isArray(SCHEDULE_DEFAULTS.closed_weekdays) && SCHEDULE_DEFAULTS.closed_weekdays.length === 0);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
