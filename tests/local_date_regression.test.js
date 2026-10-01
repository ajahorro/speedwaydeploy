import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLocalDateWindow, buildLocalMonthWindow, buildLocalDateTime } from '../frontend/src/utils/dateTimeUtils.js';

test('buildLocalDateWindow keeps the booking day anchored to local midnight boundaries', () => {
  const date = new Date(2026, 3, 15, 18, 30, 0); // local 2026-04-15
  const window = buildLocalDateWindow(date);

  assert.equal(window.startIso, '2026-04-15T00:00:00');
  assert.equal(window.endIso, '2026-04-15T23:59:59');
  assert.ok(!window.startIso.endsWith('Z'));
  assert.ok(!window.endIso.endsWith('Z'));
});

test('buildLocalMonthWindow uses local month boundaries instead of UTC rollover values', () => {
  const date = new Date(2026, 2, 10, 8, 45, 0); // March 2026
  const window = buildLocalMonthWindow(date);

  assert.equal(window.startIso, '2026-03-01T00:00:00');
  assert.equal(window.endIso, '2026-04-01T00:00:00');
  assert.ok(!window.startIso.endsWith('Z'));
  assert.ok(!window.endIso.endsWith('Z'));
});

test('buildLocalDateTime preserves the booked local time instead of converting it to UTC', () => {
  const value = buildLocalDateTime('2026-04-15', '7:30 AM');

  assert.equal(value, '2026-04-15T07:30:00');
  assert.ok(!value.endsWith('Z'));
});
