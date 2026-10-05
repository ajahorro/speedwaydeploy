// Regression guard for the calendar time-slot bug: a booking must land in the shop's hour
// row whatever timezone the admin's device is in. Run under several TZ values:
//   for tz in UTC America/Chicago Asia/Manila; do TZ=$tz node scripts/verify-shop-time.mjs; done
import assert from 'node:assert/strict';
import { shopDateString, shopHourValue, shopWallToDate } from '../frontend/src/utils/shopTime.js';

const twoPm = shopWallToDate('2026-10-05', 14);
assert.equal(twoPm.toISOString(), '2026-10-05T06:00:00.000Z');
assert.equal(shopHourValue(twoPm), 14, '14:00 Manila must read as hour 14');
assert.equal(shopDateString(twoPm), '2026-10-05');

assert.equal(shopHourValue(shopWallToDate('2026-10-05', 9.5)), 9.5);

// day boundaries: 23:30 Manila is still the 5th; 00:30 Manila is the 6th
assert.equal(shopDateString(shopWallToDate('2026-10-05', 23.5)), '2026-10-05');
assert.equal(shopDateString(new Date('2026-10-05T16:30:00Z')), '2026-10-06');
// hour windows beyond 24h stay on the shop clock (used for the 3-day fetch buffer)
assert.equal(shopDateString(shopWallToDate('2026-10-05', 48)), '2026-10-07');

console.log(`shop time OK (device TZ=${process.env.TZ || 'default'})`);
