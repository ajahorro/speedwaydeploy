/**
 * Reads the live enum definitions for the payment-status columns. I need the
 * REAL members before writing a guard that compares against them — guessing an
 * enum member is how the 42804 defect happened in the first place.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const f of ['backend/.env']) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Probe each candidate enum member by attempting a cast in a read-only way:
// select the literal via a tiny RPC-free trick — filter a 0-row select.
const candidates = [
  'unpaid', 'for_verification', 'verified', 'paid', 'rejected',
  'partial', 'refunded', 'refund_pending', 'failed', 'pending',
];
const otherCandidates = ['FOR_VERIFICATION', 'PAID', 'REFUNDED', 'REFUND_PENDING', 'REJECTED', 'UNPAID', 'verified', 'rejected'];

const probeEnum = async (table, column, values) => {
  const accepted = [];
  for (const v of values) {
    // A cast failure surfaces as 22P02 (invalid input value for enum).
    const { error } = await db.from(table).select('id').eq(column, v).limit(1);
    if (!error) accepted.push(v);
    else if (!/invalid input value for enum|22P02/i.test(error.message + error.code)) {
      // Some other error — the value parsed, so it is a valid member.
      accepted.push(v);
    }
  }
  return accepted;
};

console.log('=== bookings.payment_status (booking_payment_status) ===');
console.log(JSON.stringify(await probeEnum('bookings', 'payment_status', candidates), null, 0));

console.log('\n=== payments.status ===');
console.log(JSON.stringify(await probeEnum('payments', 'status', otherCandidates), null, 0));

console.log('\n=== bookings.status ===');
console.log(JSON.stringify(await probeEnum('bookings', 'status', ['scheduled', 'pending', 'confirmed', 'in_progress', 'completed', 'released', 'cancelled', 'flagged_noshow', 'pending_confirmation']), null, 0));