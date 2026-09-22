/**
 * Step 7.5 — Final E2E System Audit (pure-logic layer).
 * Exercises the REAL logic modules against their ACTUAL signatures.
 * Run: node scratch/verify_75_logic.mjs
 */
import assert from 'node:assert/strict';

import {
  calculateBayUsage, calculateOccupancy, calculateTotalDuration,
  filterActiveBookings, isBikeVehicleType, getVehicleWeight,
} from '../frontend/src/utils/schedulingUtils.js';
import {
  isDateBookable, isSlotBookable, normalizeConfig, SCHEDULE_DECISION_CODES,
} from '../frontend/src/domain/schedule/rules.js';
import { sanitizeVehiclePlate, sanitizeVehicleText, SHOP_CONFIG } from '../frontend/src/config/constants.js';
import { classifyScheduleError } from '../frontend/src/utils/errorRouting.js';

let pass = 0, fail = 0;
const results = [];
const test = (suite, name, fn) => {
  try { fn(); pass++; results.push(`PASS  [${suite}] ${name}`); }
  catch (e) { fail++; results.push(`FAIL  [${suite}] ${name}\n        ${e.message}`); }
};

// ═══ SUITE 3 — Bay capacity ($1.0 SUV vs $0.5 Motorcycle) + slot constraints ═══
test('S3', 'SUV / Sedan / Van each weigh 1.0 bay', () => {
  assert.equal(getVehicleWeight('SUV'), 1);
  assert.equal(getVehicleWeight('Sedan'), 1);
  assert.equal(getVehicleWeight('Van/L300'), 1);
});
test('S3', 'Motorcycle weighs 0.5 bay', () => {
  assert.equal(getVehicleWeight('Motorcycle'), 0.5);
  assert.equal(isBikeVehicleType('Motorcycle'), true);
});
test('S3', 'two motorcycles share ONE bay', () => {
  assert.equal(calculateBayUsage([{ type: 'Motorcycle' }, { type: 'Motorcycle' }]), 1);
});
test('S3', 'SUV + Motorcycle = 2 bays (a lone bike cannot share with a car)', () => {
  // calculateBayUsage = fullBays + ceil(bikes/2). One bike still needs its own
  // half-slot rounded UP, so a car + a bike = 1 + ceil(0.5) = 2.
  assert.equal(calculateBayUsage([{ type: 'SUV' }, { type: 'Motorcycle' }]), 2);
});
test('S3', 'two SUVs + Motorcycle = 3 bays', () => {
  assert.equal(calculateBayUsage([{ type: 'SUV' }, { type: 'SUV' }, { type: 'Motorcycle' }]), 3);
});
test('S3', 'three motorcycles = 2 bays (paired)', () => {
  assert.equal(calculateBayUsage([{ type: 'Motorcycle' }, { type: 'Motorcycle' }, { type: 'Motorcycle' }]), 2);
});
test('S3', 'occupancy counts each overlapping booking as 1 unit', () => {
  const bookings = [{
    id: 'b1', status: 'confirmed',
    start_datetime: '2026-10-01T09:00:00', end_datetime: '2026-10-01T11:00:00',
    vehicles: [{ id: 'v1', status: 'scheduled', vehicle_type: 'Motorcycle' }],
  }];
  const occ = calculateOccupancy(9, '2026-10-01', filterActiveBookings(bookings), [], { ...SHOP_CONFIG, MAX_BAYS: 4 });
  assert.equal(occ, 1);
});
test('S3', 'blocked slot forces FULL occupancy', () => {
  const blocks = [{ block_date: '2026-10-04', start_time: '08:00', end_time: '12:00' }];
  const occ = calculateOccupancy(9, '2026-10-04', [], blocks, { ...SHOP_CONFIG, MAX_BAYS: 3 });
  assert.equal(occ, 3);
});
test('S3', 'slot-full at capacity, then passes after dynamic expansion (2 -> 4 bays)', () => {
  const now = new Date('2026-10-10T08:00:00');
  const day = '2026-10-10';
  const mk = (id) => ({
    id, status: 'confirmed',
    start_datetime: '2026-10-10T10:00:00', end_datetime: '2026-10-10T12:00:00',
    vehicles: [{ id: `${id}-v`, status: 'scheduled', vehicle_type: 'SUV' }],
  });
  const existing = [mk('a'), mk('b')];
  const cfg2 = normalizeConfig({ slots_per_hour: 2, max_vehicles_per_staff: 99, booking_lead_time_minutes: 120, enforce_capacity: true });
  const cfg4 = normalizeConfig({ slots_per_hour: 4, max_vehicles_per_staff: 99, booking_lead_time_minutes: 120, enforce_capacity: true });

  const blocked = isSlotBookable(day, '10:00', cfg2, existing, { now });
  assert.equal(blocked.bookable, false, 'should be full at 2 bays');
  assert.equal(blocked.code, SCHEDULE_DECISION_CODES.SLOT_FULL);

  const allowed = isSlotBookable(day, '10:00', cfg4, existing, { now });
  assert.equal(allowed.bookable, true, 'should pass after expansion to 4 bays');
});

// ═══ SUITE 4 — Strict alphanumeric field guards ═══
const SPECIALS = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '<', '>', '/', '\\', ';', ':', '"', "'", '`', '~', '+', '=', '[', ']', '{', '}', '|', ',', '.', '?', '|', '₱'];
test('S4', 'sanitizeVehiclePlate strips ALL special characters', () => {
  for (const s of SPECIALS) assert.equal(sanitizeVehiclePlate(`AB${s}123`), 'AB123', `failed on ${s}`);
});
test('S4', 'sanitizeVehiclePlate uppercases, keeps alphanumerics', () => {
  assert.equal(sanitizeVehiclePlate('abc-123'), 'ABC123');
});
test('S4', 'sanitizeVehicleText strips specials but normalises spaces', () => {
  assert.equal(sanitizeVehicleText('Toyota   Vios!!'), 'Toyota Vios');
  for (const s of SPECIALS) assert.equal(sanitizeVehicleText(`A${s}B`), 'AB', `failed on ${s}`);
});

// ═══ SUITE 5 — Schedule rules (past / closed / advance / lead / capacity) ═══
const NOW = new Date('2026-10-15T10:00:00');
const cfg = normalizeConfig({
  booking_lead_time_minutes: 120, max_advance_days: 30,
  closed_weekdays: [0], enforce_capacity: true, slots_per_hour: 2,
  max_vehicles_per_staff: 99, opening_hour: 8, closing_hour: 18,
});
test('S5', 'past date rejected (PAST_DATE)', () => {
  const d = isDateBookable('2026-10-14', cfg, { now: NOW });
  assert.equal(d.bookable, false);
  assert.equal(d.code, SCHEDULE_DECISION_CODES.PAST_DATE);
});
test('S5', 'closed weekday (Sunday) rejected (CLOSED_WEEKDAY)', () => {
  const d = isDateBookable('2026-10-18', cfg, { now: NOW }); // Sunday
  assert.equal(d.bookable, false);
  assert.equal(d.code, SCHEDULE_DECISION_CODES.CLOSED_WEEKDAY);
});
test('S5', 'beyond advance window rejected', () => {
  const d = isDateBookable('2027-01-01', cfg, { now: NOW });
  assert.equal(d.bookable, false);
  assert.equal(d.code, SCHEDULE_DECISION_CODES.BEYOND_ADVANCE_WINDOW);
});
test('S5', 'lead-time violation rejected (LEAD_TIME)', () => {
  const s = isSlotBookable('2026-10-15', '11:00', cfg, [], { now: NOW }); // 60m out < 120m
  assert.equal(s.bookable, false);
  assert.equal(s.code, SCHEDULE_DECISION_CODES.LEAD_TIME);
});
test('S5', 'valid future slot accepted', () => {
  const s = isSlotBookable('2026-10-15', '14:00', cfg, [], { now: NOW });
  assert.equal(s.bookable, true);
});
test('S5', 'past-closing slot rejected (SLOT_BLOCKED)', () => {
  const s = isSlotBookable('2026-10-15', '17:30', cfg, [], { now: NOW, durationMinutes: 120 });
  assert.equal(s.bookable, false);
  assert.equal(s.code, SCHEDULE_DECISION_CODES.SLOT_BLOCKED);
});
test('S5', 'enforce_capacity=false bypasses the slot-full block', () => {
  const openCfg = normalizeConfig({ ...cfg, enforce_capacity: false, slots_per_hour: 1 });
  const mk = (id) => ({ id, status: 'confirmed', start_datetime: '2026-10-15T14:00:00', end_datetime: '2026-10-15T16:00:00', vehicles: [{ vehicle_type: 'SUV' }] });
  const s = isSlotBookable('2026-10-15', '14:00', openCfg, [mk('a'), mk('b'), mk('c')], { now: NOW });
  assert.equal(s.bookable, true);
});

// ═══ SUITE 2 (math) — duration + classifier ═══
test('S2', 'total duration SUMS service lines across vehicles', () => {
  // calculateTotalDuration accumulates ALL service durations (total labour),
  // defaulting to 60 minutes when no services are selected.
  const v = [
    { services: [{ durationMinutes: 60 }, { durationMinutes: 30 }] },
    { services: [{ durationMinutes: 120 }] },
  ];
  assert.equal(calculateTotalDuration(v), 210);
  assert.equal(calculateTotalDuration([]), 60);
});
test('S2', 'classifier maps capacity vs date correctly', () => {
  assert.equal(classifyScheduleError('The selected time is full.'), 'CAPACITY_EXCEEDED');
  assert.equal(classifyScheduleError('choose a future date and time'), 'PAST_DATE');
  assert.equal(classifyScheduleError('Invalid login credentials'), null);
});

console.log('\n═══ Step 7.5 — Logic E2E ═══\n');
console.log(results.join('\n'));
console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);