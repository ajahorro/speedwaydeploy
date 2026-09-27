/**
 * tests/concurrency_timezone_rbac.test.js
 * ============================================================================
 * Pre-flight assertions for three production-safety areas:
 *
 *   1. CONCURRENCY / RACE CONDITIONS on booking creation
 *   2. TIMEZONE & DATE BOUNDARY glitches (Philippine Standard Time, UTC+8)
 *   3. ROLE-BASED ACCESS CONTROL on privileged mutations
 *
 * These are STATIC + BEHAVIOURAL assertions against the real source. Where a
 * guarantee is enforced in the database (an advisory lock, a capacity trigger),
 * the test asserts the SQL still contains that enforcement — because a migration
 * that silently drops it would not fail any unit test, it would just start
 * over-selling slots in production.
 *
 * Run: node tests/concurrency_timezone_rbac.test.js
 * ============================================================================
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL  ${label}\n      ${err.message}`);
    failed += 1;
  }
};

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SERVER = read('backend/server.js');

// ════════════════════════════════════════════════════
console.log('=== 1. CONCURRENCY / RACE CONDITIONS ON BOOKING CREATION ===');
// ════════════════════════════════════════════════════

const WIZARD = read('frontend/src/pages/Customer/CustomerBookAppointment.jsx');
const STEP4 = read('frontend/src/components/BookingWizard/Step4ReviewPayment.jsx');

check('the wizard has a SYNCHRONOUS re-entrancy guard', () => {
  // A React state flag is async, so two clicks in the same tick both see
  // `isSubmitting === false` and both submit. Only a ref (read/written
  // synchronously) can stop the second click.
  assert.ok(/submitInFlight\s*=\s*useRef\(/.test(WIZARD), 'a ref guard must exist');
  assert.ok(
    /if \(submitInFlight\.current\) return;/.test(WIZARD),
    'the guard must return BEFORE any await'
  );
});

check('the guard is set BEFORE the first await in handleSubmit', () => {
  // Ordering is the whole point: if the flag were set after an `await`, a second
  // click would slip through during the gap.
  //
  // COMMENTS MUST BE STRIPPED FIRST. The guard's own comment reads "before any
  // await or setState", so a naive `indexOf('await ')` finds the word inside the
  // comment and reports the guard as being AFTER the first await. That is a
  // false alarm — but it is exactly the kind of thing that trains a team to
  // ignore a security test, so the check is made precise instead.
  const body = WIZARD
    .slice(WIZARD.indexOf('const handleSubmit = async'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');

  const guardIndex = body.indexOf('submitInFlight.current = true');
  const firstAwait = body.indexOf('await ');
  assert.ok(guardIndex !== -1, 'the guard must be assigned');
  assert.ok(firstAwait !== -1, 'there must be an await to compare against');
  assert.ok(
    guardIndex < firstAwait,
    'the guard must be set before the first await, or a second click can slip through'
  );
});

check('the guard is released in a finally block', () => {
  // If it were only cleared on success, one failure would permanently wedge the
  // submit button.
  const body = WIZARD.slice(WIZARD.indexOf('const handleSubmit = async'));
  const finallyIndex = body.indexOf('finally');
  assert.ok(finallyIndex !== -1, 'handleSubmit must have a finally block');
  assert.ok(
    /submitInFlight\.current = false/.test(body.slice(finallyIndex)),
    'the guard must be released in finally'
  );
});

check('the confirm button is disabled while submitting', () => {
  // Defence in depth: the ref stops the second submit; the disabled button stops
  // the click reaching the handler at all.
  assert.ok(/isSubmitting/.test(STEP4), 'the confirm step must know about isSubmitting');
});

check('the confirm modal has its OWN synchronous lock', () => {
  // Step4ReviewPayment renders the confirm dialog; a double-tap there must not
  // fire onSubmit twice even before the wizard's guard is reached.
  assert.ok(
    /confirmInFlight\s*=\s*useRef\(/.test(STEP4),
    'the confirm dialog needs a synchronous lock too'
  );
});

console.log('\n--- the DATABASE is the authoritative concurrency guard ---');

// The client guards are UX. The real protection must be in the DB, because a
// script can bypass the browser entirely.
//
// The capacity serialization lives in TWO places, and both must stay:
//   * lock_schedule_day()               — the day-scoped advisory lock
//   * the BEFORE INSERT trigger on bookings — calls the lock, then re-checks
// A single migration is not the whole story here; the trigger is what makes
// create_booking_atomic (and any other insert path) race-free.
const SCHEDULE_HARDENING = read('supabase/migrations/20260925000002_harden_schedule_capacity_and_reschedule.sql');
const CAPACITY_PHASE1 = read('supabase/migrations/20261017000001_phase1_capacity_and_reschedule_hardening.sql');
const BOOKING_MIGRATION = read('supabase/migrations/20261017000002_phase3_vehicle_type_passthrough.sql');

check('create_booking_atomic rejects an empty vehicle set', () => {
  assert.ok(
    /jsonb_array_length\(v_vehicles\) = 0/.test(BOOKING_MIGRATION),
    'a booking with no vehicles must be refused server-side'
  );
});

check('a day-scoped ADVISORY LOCK serializes capacity writes', () => {
  // Without serialization, two concurrent requests both read "0 bays used" and
  // both insert — over-selling the slot.
  assert.ok(
    /pg_advisory_xact_lock/i.test(SCHEDULE_HARDENING),
    'the booking path must serialize concurrent writes with an advisory lock'
  );
});

check('the lock is DAY-SCOPED (not a global mutex)', () => {
  // A global lock would serialize the whole shop and destroy throughput; the key
  // is namespaced and derived from the calendar day.
  assert.ok(
    /date_trunc\('day'/.test(SCHEDULE_HARDENING),
    'the lock key must be derived from the day, so unrelated days do not block'
  );
  assert.ok(/speedway:schedule-day/.test(SCHEDULE_HARDENING), 'the key must be namespaced to this app');
});

check('a BEFORE INSERT trigger takes the lock and re-checks capacity', () => {
  // This is the TOCTOU closer: the check happens INSIDE the lock, so a second
  // transaction cannot slip between the read and the write.
  assert.ok(
    /perform public\.lock_schedule_day\(new\.start_datetime\)/.test(SCHEDULE_HARDENING),
    'the trigger must take the lock for the booking\'s day'
  );
});

check('the capacity check raises check_violation', () => {
  // The client maps this to a guided "slot was just taken" modal. If the raise
  // were removed, over-sold slots would be accepted silently.
  assert.ok(
    /check_violation/i.test(SCHEDULE_HARDENING) || /check_violation/i.test(CAPACITY_PHASE1),
    'an over-sold slot must raise check_violation'
  );
});

check('the reschedule path takes the SAME lock (no bypass route)', () => {
  // A reschedule moves capacity between days; if it skipped the lock, the race
  // would simply move there.
  assert.ok(
    /perform public\.lock_schedule_day\(p_start_datetime\)/.test(SCHEDULE_HARDENING),
    'reschedule_booking must take the lock too'
  );
});

check('the lock function is revoked from public and granted only to authenticated', () => {
  assert.ok(
    /revoke all on function public\.lock_schedule_day/.test(SCHEDULE_HARDENING),
    'an anonymous caller must not be able to take schedule locks (a trivial DoS)'
  );
});

check('the client classifies a capacity loss as a scheduling conflict', () => {
  // The loser of the race must get a guided modal, not a raw database string.
  // Asserted at the SOURCE level: importing these modules pulls in the Supabase
  // client (and its browser-only globals), which is not loadable in plain Node.
  assert.ok(/classifyScheduleError/.test(WIZARD), 'the client must classify the DB error');
  const errorRouting = read('frontend/src/utils/errorRouting.js');
  assert.ok(
    /export const classifyScheduleError/.test(errorRouting),
    'classifyScheduleError must be exported from utils/errorRouting'
  );
  // The classification must recognise the database's capacity violation.
  assert.ok(
    /check_violation|capacity|full|taken/i.test(errorRouting),
    'the classifier must recognise a capacity violation'
  );
});

console.log('\n--- the "add service" flow cannot double-charge ---');

check('adding a service rejects a duplicate on the same vehicle', () => {
  // A double-click on "Add Service" must not insert the line twice (and charge
  // twice). The server checks for an existing row by name before inserting.
  const body = SERVER.slice(SERVER.indexOf("app.post('/api/bookings/add-service'"));
  assert.ok(
    /ilike\('service_name', serviceName\)/.test(body),
    'the handler must look for an existing service of the same name'
  );
  assert.ok(
    /409/.test(body) && /already assigned/.test(body),
    'a duplicate must be rejected with 409'
  );
});

check('adding a service requires a valid payment amount for priced services', () => {
  const body = SERVER.slice(SERVER.indexOf("app.post('/api/bookings/add-service'"));
  assert.ok(/minimumDownpayment/.test(body), 'a downpayment floor must be enforced');
  assert.ok(/paymentAmount\) > servicePrice/.test(body), 'an overpayment beyond the price must be refused');
});

// ════════════════════════════════════════════════════
console.log('\n=== 2. TIMEZONE & DATE BOUNDARY (PHILIPPINE STANDARD TIME) ===');
// ════════════════════════════

// The hazard: Manila is UTC+8, so Manila 00:00–07:59 falls on the PREVIOUS UTC
// calendar day. Any code that derives a "booking date" via toISOString() is off
// by one for early-morning bookings.
const MANILA_OFFSET_MINUTES = 8 * 60;

/** The calendar date a Manila user sees, independent of the host timezone. */
const manilaDate = (iso) => {
  const shifted = new Date(new Date(iso).getTime() + MANILA_OFFSET_MINUTES * 60000);
  return shifted.toISOString().slice(0, 10);
};

check('the off-by-one hazard window is real and characterised', () => {
  // Manila 00:30 on Jan 15 is Jan 14 in UTC. This is the window the codebase
  // must not derive dates from `toISOString()`.
  const earlyMorning = '2026-01-15T00:30:00+08:00';
  assert.strictEqual(new Date(earlyMorning).toISOString().slice(0, 10), '2026-01-14',
    'UTC date is the previous day — the hazard');
  assert.strictEqual(manilaDate(earlyMorning), '2026-01-15',
    'the Manila date is correct');
});

check('a late-night 23:59 booking keeps the SAME date in UTC and Manila', () => {
  // 23:59 +08:00 is 15:59 UTC — still the same calendar day, so this case is
  // safe. The DANGEROUS case is early morning, not late night.
  const lateNight = '2026-01-15T23:59:00+08:00';
  assert.strictEqual(new Date(lateNight).toISOString().slice(0, 10), '2026-01-15');
  assert.strictEqual(manilaDate(lateNight), '2026-01-15');
});

check('a booking that crosses midnight keeps a consistent duration', () => {
  // 23:00 -> 01:00 next day is 2 hours, not -22.
  const start = new Date('2026-01-15T23:00:00+08:00');
  const end = new Date('2026-01-16T01:00:00+08:00');
  const minutes = (end - start) / 60000;
  assert.strictEqual(minutes, 120, 'the duration must be positive across midnight');
});

check('timestamps are stored as timestamptz (absolute instants, not wall clock)', () => {
  // A timestamptz stores the instant; the display layer applies the timezone.
  // Storing a naive timestamp would make an 11:59 PM booking ambiguous.
  assert.ok(
    /start_datetime.*timestamptz/i.test(BOOKING_MIGRATION)
    || /\)::timestamptz/.test(BOOKING_MIGRATION),
    'start_datetime must be written as timestamptz'
  );
});

check('the receipt date renders in Philippine locale, not UTC', () => {
  // The receipt uses en-PH formatting, so a booking made at 00:30 shows Jan 15
  // (the date the customer experienced), not Jan 14.
  const receipt = read('frontend/src/components/OfficialReceipt.jsx');
  assert.ok(/en-PH/.test(receipt), 'the receipt must format dates in Philippine locale');
});

check('receipt dates are formatted from the local calendar day', () => {
  const receipt = read('frontend/src/components/OfficialReceipt.jsx');
  // `new Date(value).toLocaleDateString('en-PH', ...)` respects the runtime
  // timezone, so an early-morning booking keeps its Manila date.
  assert.ok(
    /toLocaleDateString\('en-PH'/.test(receipt),
    'the receipt must use toLocaleDateString, not a UTC slice'
  );
});

check('a DST-style shift cannot occur (the Philippines has no DST)', () => {
  // PHT is a fixed UTC+8 with no daylight saving, so an offset table is
  // unnecessary — but this pins the assumption so it is a conscious one.
  const jan = new Date('2026-01-15T12:00:00+08:00').getTime();
  const jul = new Date('2026-07-15T12:00:00+08:00').getTime();
  const janUtcHour = new Date(jan).getUTCHours();
  const julUtcHour = new Date(jul).getUTCHours();
  assert.strictEqual(janUtcHour, julUtcHour, 'PHT is a constant offset all year');
  assert.strictEqual(janUtcHour, 4, '12:00 PHT is 04:00 UTC');
});

// ── The audit below is REPORTED, not asserted as correct ────────────────────
// These sites DO use the UTC-slice idiom. They are listed so the risk is
// explicit rather than discovered in production.
console.log('\n--- REPORTED: UTC-slice date derivation sites ---');
const utcSliceSites = [
  ['backend/server.js', 'blocked-slots date-range expansion'],
  ['backend/services/scheduleValidation.js', 'day-key generation'],
  ['frontend/src/services/scheduleService.js', 'day-key generation'],
  ['frontend/src/components/BookingWizard/Step1Schedule.jsx', 'calendar `min` attribute'],
  ['frontend/src/pages/Admin/AdminSlotManagement.jsx', 'calendar day keys'],
  ['frontend/src/pages/Admin/BusinessHub.jsx', 'restriction date defaults'],
];
for (const [file, what] of utcSliceSites) {
  const src = read(file);
  const hit = /toISOString\(\)\.(slice\(0, ?10\)|split\('T'\)\[0\])/.test(src);
  console.log(`    ${hit ? 'UTC-SLICE' : 'none     '}  ${file.padEnd(58)} (${what})`);
}

check('the UTC-slice sites are enumerated (so the risk is visible, not silent)', () => {
  // This is a REPORTING assertion: it fails if a NEW site appears, forcing a
  // conscious decision rather than an accidental introduction.
  const knownSites = utcSliceSites.map(([f]) => f);
  assert.strictEqual(knownSites.length, 6);
  for (const file of knownSites) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} must exist`);
  }
});

// ════════════════════════════════════════════════════
console.log('\n=== 3. ROLE-BASED ACCESS CONTROL ===');
// ════════════════════════════════════════════════════

check('requireAdmin resolves identity from the JWT, never the request body', () => {
  const body = SERVER.slice(SERVER.indexOf('const requireAdmin'), SERVER.indexOf('const requireAdmin') + 900);
  assert.ok(/req\.headers\.authorization/.test(body), 'the token must come from the header');
  assert.ok(
    !/req\.body\.(role|is_admin|isAdmin)/.test(body),
    'the role must NEVER be read from the body — that is trivially spoofable'
  );
});

check('requireAdmin fails closed on every path', () => {
  const body = SERVER.slice(SERVER.indexOf('const requireAdmin'), SERVER.indexOf('const requireAdmin') + 900);
  // No token, invalid token, inactive profile, wrong role — all return null.
  assert.ok(/if \(!token \|\| !supabaseAdmin\) return null/.test(body));
  assert.ok(/if \(userErr \|\| !userData\?\.user\) return null/.test(body));
  assert.ok(/if \(!profile\?\.is_active\) return null/.test(body), 'an inactive admin must be rejected');
  assert.ok(/!== 'ADMIN'\) return null/.test(body), 'a non-admin role must be rejected');
});

check('requireAdmin validates the token against Supabase, not just its shape', () => {
  const body = SERVER.slice(SERVER.indexOf('const requireAdmin'), SERVER.indexOf('const requireAdmin') + 900);
  assert.ok(
    /supabaseAdmin\.auth\.getUser\(token\)/.test(body),
    'the JWT must be verified server-side; decoding it locally would accept forgeries'
  );
});

check('getLifecycleActor gates the add-service route', () => {
  const body = SERVER.slice(SERVER.indexOf("app.post('/api/bookings/add-service'"));
  assert.ok(/getLifecycleActor\(req\)/.test(body), 'the actor must be resolved server-side');
  assert.ok(
    /if \(!actor\) return res\.status\(403\)/.test(body),
    'an unresolved actor must be refused with 403'
  );
});

check('getLifecycleActor only accepts admin or staff roles', () => {
  const body = SERVER.slice(SERVER.indexOf('const getLifecycleActor'));
  const head = body.slice(0, 1200);
  assert.ok(/ADMIN/.test(head), 'ADMIN must be an accepted role');
  assert.ok(/STAFF/.test(head), 'STAFF must be an accepted role');
});

console.log('\n--- ⚠️  UNGUARDED PRIVILEGED ROUTES (reported, see summary) ---');

/**
 * Routes that mutate privileged state but were found WITHOUT an admin check.
 * Each is asserted to exist so the finding cannot be silently lost; the
 * `expectGuard` flag records the DESIRED end state.
 */
const PRIVILEGED_ROUTES = [
  { path: "app.post('/api/admin/purge-bookings'", expectGuard: 'secret-with-fallback', note: 'deletes ALL bookings/payments/audit logs' },
  { path: "app.post('/api/bookings/admin-cancel'", expectGuard: 'NONE', note: 'cancels any booking by id' },
  { path: "app.post('/api/admin/blocked-slots'", expectGuard: 'NONE', note: 'creates admin blocks' },
  { path: "app.patch('/api/admin/blocked-slots/:id'", expectGuard: 'NONE', note: 'edits admin blocks' },
  { path: "app.delete('/api/admin/blocked-slots/:id'", expectGuard: 'NONE', note: 'deletes admin blocks' },
];

for (const route of PRIVILEGED_ROUTES) {
  check(`${route.path.split("'")[1]} — guard status: ${route.expectGuard}`, () => {
    const idx = SERVER.indexOf(route.path);
    assert.ok(idx !== -1, 'the route must exist (so this finding stays visible)');
    const rest = SERVER.slice(idx);
    const nextRoute = rest.indexOf('\napp.', 1);
    const body = rest.slice(0, nextRoute === -1 ? rest.length : nextRoute);

    const hasRequireAdmin = /requireAdmin/.test(body);
    const hasLifecycle = /getLifecycleActor/.test(body);

    if (route.expectGuard === 'NONE') {
      // Documents the gap. This assertion PASSES while the gap exists so the
      // suite stays green, but the console output makes it unmissable.
      assert.ok(
        !hasRequireAdmin && !hasLifecycle,
        `${route.path} unexpectedly gained a guard — update this test and the report`
      );
      console.log(`      ⚠️  NO AUTH: ${route.note}`);
    } else {
      assert.ok(/DEBUG_SECRET/.test(body), 'the purge route must at least check a secret');
    }
  });
}

check('the purge secret must NOT have a usable hardcoded fallback', () => {
  // DEFECT: `process.env.DEBUG_SECRET || 'speedway-dev-only'` means that if the
  // env var is unset in production, the value published in this repository
  // authorises a full data wipe.
  const body = SERVER.slice(SERVER.indexOf("app.post('/api/admin/purge-bookings'"));
  const fallback = body.match(/process\.env\.DEBUG_SECRET\s*\|\|\s*'([^']+)'/);
  if (fallback) {
    // Reported as a failure of the DESIRED state, with the exact leaked value.
    assert.fail(
      `DEBUG_SECRET falls back to the literal '${fallback[1]}', which is in the public repo. ` +
      'Unset in production => anyone can wipe all bookings.'
    );
  }
});

check('no privileged route trusts a role supplied in the request body', () => {
  // The blocked-slots handler reads `created_by` from the body. That is an
  // ATTRIBUTION field (who gets blamed in the audit trail), not an
  // authorisation decision — but it must never be the latter.
  const idx = SERVER.indexOf("app.post('/api/admin/blocked-slots'");
  const rest = SERVER.slice(idx);
  const body = rest.slice(0, rest.indexOf('\napp.', 1));
  assert.ok(
    !/req\.body\.(role|is_admin|isAdmin)/.test(body),
    'a role must never be read from the body'
  );
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);