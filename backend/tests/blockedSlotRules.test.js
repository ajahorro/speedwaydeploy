const test = require('node:test');
const assert = require('node:assert/strict');
const { blockedSlotsOverlap, blockWindow } = require('../services/blockedSlotRules');

test('detects partial closure overlap but allows adjacent windows', () => {
  const existing = { block_date: '2026-10-08', start_time: '09:00:00', end_time: '11:00:00' };
  assert.equal(blockedSlotsOverlap(
    { block_date: '2026-10-08', start_time: '10:00:00', end_time: '12:00:00' },
    existing
  ), true);
  assert.equal(blockedSlotsOverlap(
    { block_date: '2026-10-08', start_time: '11:00:00', end_time: '12:00:00' },
    existing
  ), false);
});

test('treats either full-day closure as overlapping every closure that day', () => {
  const fullDay = { block_date: '2026-10-08', start_time: null, end_time: null };
  const partial = { block_date: '2026-10-08', start_time: '09:00:00', end_time: '10:00:00' };
  assert.equal(blockedSlotsOverlap(fullDay, partial), true);
  assert.equal(blockedSlotsOverlap(partial, fullDay), true);
  assert.equal(blockedSlotsOverlap(fullDay, { ...partial, block_date: '2026-10-09' }), false);
});

test('converts closure boundaries using the shop timezone and next midnight', () => {
  assert.deepEqual(blockWindow({
    block_date: '2026-10-08',
    start_time: '08:00:00',
    end_time: '09:30:00',
  }), {
    start: '2026-10-08T00:00:00.000Z',
    end: '2026-10-08T01:30:00.000Z',
  });
  assert.deepEqual(blockWindow({
    block_date: '2026-10-08',
    start_time: null,
    end_time: null,
  }), {
    start: '2026-10-07T16:00:00.000Z',
    end: '2026-10-08T16:00:00.000Z',
  });
});

test('rejects invalid or incomplete time ranges', () => {
  assert.throws(() => blockedSlotsOverlap(
    { block_date: '2026-10-08', start_time: '10:00', end_time: null },
    { block_date: '2026-10-08', start_time: '11:00', end_time: '12:00' }
  ), /leave both times empty/);
  assert.throws(() => blockWindow({
    block_date: '2026-02-30',
    start_time: null,
    end_time: null,
  }), /valid closure date/);
});
