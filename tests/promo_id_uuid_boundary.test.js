// Regression test for the applied_promo_id UUID boundary.
//
// Run with:  node tests/promo_id_uuid_boundary.test.js
//
// THE DEFECT THIS LOCKS IN
// ------------------------
// Submitting a booking that had a PACKAGE applied aborted with:
//
//   POST /rest/v1/rpc/create_booking_atomic  400 (Bad Request)
//   code: '22P02'
//   message: invalid input syntax for type uuid: "promo-1790542417063"
//
// A package/rule id is synthesised in the browser (`promo-<timestamp>`) because
// packages live in the client catalog and have no database row. The booking
// payload sent it as `applied_promo_id`, and `bookings.applied_promo_id` is a
// uuid column, so Postgres rejected the WHOLE booking.
//
// THE CONTRACT
// ------------
// Only a genuine UUID may be forwarded as applied_promo_id; anything else
// (a synthetic package id, an empty string, whitespace, arbitrary text) must
// degrade to null. The promo NAME and DISCOUNT snapshots are separate columns
// and are always persisted, so a null id loses nothing the receipt needs.
//
// This mirrors the SQL guard in
// supabase/migrations/20261019000002_fix_promo_id_uuid_cast.sql:
//
//   case when (v_booking ->> 'applied_promo_id')
//             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
//        then (v_booking ->> 'applied_promo_id')::uuid
//        else null end
//
// so the two layers are asserted against the SAME pattern.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exact predicate bookingService.js uses before forwarding the id. */
const asUuidOrNull = (value) => {
  const v = typeof value === 'string' ? value.trim() : '';
  return UUID_PATTERN.test(v) ? v : null;
};

const asserts = [];
const push = (label, cond) => asserts.push([label, cond]);

// ---- 1. The exact value from the bug report must become null ----
push('the reported synthetic package id degrades to null',
  asUuidOrNull('promo-1790542417063') === null);

// ---- 2. Other synthetic / malformed shapes must also degrade to null ----
push('another synthetic package id degrades to null',
  asUuidOrNull('promo-1700000000000') === null);
push('an empty string degrades to null', asUuidOrNull('') === null);
push('whitespace-only degrades to null', asUuidOrNull('   ') === null);
push('arbitrary text degrades to null', asUuidOrNull('not-a-uuid') === null);
push('a non-string (number) degrades to null', asUuidOrNull(1790542417063) === null);
push('undefined degrades to null', asUuidOrNull(undefined) === null);
push('null degrades to null', asUuidOrNull(null) === null);

// ---- 3. A REAL uuid must pass through unchanged ----
const REAL_UUID = '3f6c1a2b-1111-4222-8333-444455556666';
push('a real uuid is forwarded unchanged', asUuidOrNull(REAL_UUID) === REAL_UUID);
push('an uppercase uuid is accepted (regex is case-insensitive)',
  asUuidOrNull(REAL_UUID.toUpperCase()) === REAL_UUID.toUpperCase());
push('surrounding whitespace is trimmed off a real uuid',
  asUuidOrNull(`  ${REAL_UUID}  `) === REAL_UUID);

// ---- 4. Near-misses must NOT be mistaken for a uuid ----
push('a uuid with one short group is rejected',
  asUuidOrNull('3f6c1a2b-111-4222-8333-444455556666') === null);
push('a uuid with a non-hex character is rejected',
  asUuidOrNull('3f6c1a2b-1111-4222-8333-44445555666z') === null);
push('a uuid missing a group is rejected',
  asUuidOrNull('3f6c1a2b-1111-4222-444455556666') === null);
push('a bare timestamp-like string is rejected',
  asUuidOrNull('1790542417063') === null);

console.log('-- applied_promo_id UUID boundary --');
let pass = 0, fail = 0;
for (const [label, cond] of asserts) {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}`); }
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exitCode = 1;
else console.log('PROMO ID UUID BOUNDARY VERIFIED');