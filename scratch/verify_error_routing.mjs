// Verifies the Step 7.3 error-routing classifier against the REAL error strings
// raised by the reschedule_booking RPC / validator backend.
import { classifyScheduleError, toCleanMessage } from '../frontend/src/utils/errorRouting.js';

const cases = [
  // string as raised by DB
  ['The selected time is in the past. Please choose a future appointment time.', 'PAST_DATE'],
  ['The selected time is full. Please choose another appointment time.', 'CAPACITY_EXCEEDED'],
  ['The shop has marked this date as unavailable.', 'BLOCKED_DATE'],
  ['We are closed on that day', 'CLOSED_WEEKDAY'],
  ['That date is too far in advance', 'BEYOND_ADVANCE_WINDOW'],
  ['Please book with more notice (lead time)', 'LEAD_TIME'],
  ['The shop has reserved or blocked this slot. Please choose another time.', 'SLOT_UNAVAILABLE'],
  ['This date is blocked by the administrator', 'BLOCKED_DATE'],
  ['The shop has marked this date as unavailable', 'BLOCKED_DATE'],
  ['That date is not available', 'SLOT_UNAVAILABLE'],
  ['Failed to fetch', 'VALIDATION_UNAVAILABLE'],
  // Error object shapes
  [{ message: 'The selected time is full.', details: '', hint: '' }, 'CAPACITY_EXCEEDED'],
  [{ message: 'network unreachable' }, 'VALIDATION_UNAVAILABLE'],
  // Non-schedule errors must NOT classify (should fall through to a toast)
  ['Email is already registered', null],
  ['Invalid login credentials', null],
  ['', null],
  [null, null],
];

let pass = 0, fail = 0;
console.log('=== Step 7.3 error-routing classifier ===\n');
for (const [input, expected] of cases) {
  const got = classifyScheduleError(input);
  const ok = got === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  expected=${String(expected).padEnd(22)} got=${String(got).padEnd(22)} <- ${JSON.stringify(input).slice(0, 70)}`);
  ok ? pass++ : fail++;
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log('toCleanMessage(file with no msg) ->', JSON.stringify(toCleanMessage(null, 'fallback')));
process.exit(fail === 0 ? 0 : 1);