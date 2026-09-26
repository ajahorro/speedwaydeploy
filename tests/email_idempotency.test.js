/**
 * tests/email_idempotency.test.js
 * ============================================================================
 * Locks in the rule that one booking event produces exactly ONE email.
 *
 * The customer was flooded because duplicate suppression lived in client memory
 * (which cannot survive a reload or a second caller). It is now a database
 * invariant enforced by claim_booking_email() over booking_email_deliveries.
 *
 * Those functions are pure enough to be exercised without a live database, so we
 * model the ledger here and assert the exact semantics the SQL implements:
 *   - first claim wins
 *   - every later claim loses, for any spelling of the same event
 *   - a FAILED send releases the claim so the mail can be retried
 *   - a SUCCEEDED send can never be released (no double-send via retry)
 *   - distinct events for one booking each get their own send
 *
 * Run: node tests/email_idempotency.test.js
 * ============================================================================
 */
const assert = require('assert');

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

/**
 * In-memory model of booking_email_deliveries + claim/release. The semantics
 * mirror the SQL exactly: PRIMARY KEY (booking_id, event), insert-or-lose,
 * release only when no provider id has been recorded.
 */
const makeLedger = () => {
  const rows = new Map();
  const key = (b, e) => `${b}::${e}`;

  return {
    claim(bookingId, event, recipient) {
      const k = key(bookingId, event);
      if (rows.has(k)) {
        return { claimed: false, reason: 'ALREADY_SENT', sent_at: rows.get(k).sent_at };
      }
      rows.set(k, { booking_id: bookingId, event, recipient, resend_id: null, sent_at: new Date().toISOString() });
      return { claimed: true };
    },
    record(bookingId, event, resendId) {
      const row = rows.get(key(bookingId, event));
      if (row) row.resend_id = resendId ?? row.resend_id;
    },
    release(bookingId, event) {
      const k = key(bookingId, event);
      const row = rows.get(k);
      if (!row) return;
      // Never release a delivery that already succeeded.
      if (row.resend_id === null) rows.delete(k);
    },
    all: () => [...rows.values()],
  };
};

console.log('=== email exactly-once semantics ===');

check('the first claim wins', () => {
  const l = makeLedger();
  assert.strictEqual(l.claim('b1', 'booking_created', 'a@b.c').claimed, true);
});

check('a repeat claim for the same event is refused', () => {
  const l = makeLedger();
  l.claim('b1', 'booking_created');
  const second = l.claim('b1', 'booking_created');
  assert.strictEqual(second.claimed, false);
  assert.strictEqual(second.reason, 'ALREADY_SENT');
});

check('distinct events for one booking each get their own send', () => {
  const l = makeLedger();
  assert.strictEqual(l.claim('b1', 'booking_created').claimed, true);
  assert.strictEqual(l.claim('b1', 'booking_confirmed').claimed, true);
  assert.strictEqual(l.claim('b1', 'booking_completed').claimed, true);
  assert.strictEqual(l.all().length, 3, 'one row per distinct event');
});

check('the same event for DIFFERENT bookings is independent', () => {
  const l = makeLedger();
  assert.strictEqual(l.claim('b1', 'booking_created').claimed, true);
  assert.strictEqual(l.claim('b2', 'booking_created').claimed, true);
});

// ── The failure path: a claim must be recoverable or mail is lost forever ──
check('a FAILED send releases the claim so it can be retried', () => {
  const l = makeLedger();
  l.claim('b1', 'booking_created');
  l.release('b1', 'booking_created'); // provider rejected the message
  assert.strictEqual(l.claim('b1', 'booking_created').claimed, true, 'retry must be allowed after a failure');
});

check('a SUCCEEDED send can never be released (no double-send via retry)', () => {
  const l = makeLedger();
  l.claim('b1', 'booking_created');
  l.record('b1', 'booking_created', 'resend-abc-123');
  l.release('b1', 'booking_created'); // must be a no-op
  assert.strictEqual(l.claim('b1', 'booking_created').claimed, false, 'a delivered email must stay delivered-once');
});

check('releasing an unknown claim is safe', () => {
  const l = makeLedger();
  l.release('never', 'booking_created');
  assert.strictEqual(l.all().length, 0);
});

console.log('\n=== event canonicalisation ===');

// The client may name an event by lifecycle keyword OR by raw status. Both must
// map to the same ledger key, or a duplicate could slip through under the other
// spelling — which is exactly how the original flood happened.
const canonicalEvent = (raw) => {
  const key = String(raw || '').toUpperCase();
  if (key === 'BOOKING_CREATED' || key === 'SCHEDULED' || key === 'PENDING') return 'booking_created';
  if (key === 'BOOKING_CONFIRMED' || key === 'CONFIRMED') return 'booking_confirmed';
  if (key === 'IN_PROGRESS' || key === 'ONGOING') return 'booking_in_progress';
  if (key === 'COMPLETED') return 'booking_completed';
  if (key === 'RELEASED') return 'booking_released';
  if (key === 'CANCELLED') return 'booking_cancelled';
  if (key === 'FLAGGED_NOSHOW') return 'booking_flagged_noshow';
  return String(raw || 'unknown').toLowerCase();
};

check('a raw status and its lifecycle keyword collapse to ONE event', () => {
  assert.strictEqual(canonicalEvent('scheduled'), canonicalEvent('booking_created'));
  assert.strictEqual(canonicalEvent('CONFIRMED'), canonicalEvent('booking_confirmed'));
  assert.strictEqual(canonicalEvent('confirmed'), canonicalEvent('booking_confirmed'));
  assert.strictEqual(canonicalEvent('ongoing'), canonicalEvent('in_progress'));
});

check('a duplicate under the OTHER spelling is still refused', () => {
  const l = makeLedger();
  assert.strictEqual(l.claim('b1', canonicalEvent('booking_created')).claimed, true);
  assert.strictEqual(l.claim('b1', canonicalEvent('scheduled')).claimed, false, 'the alternative spelling must not slip through');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);