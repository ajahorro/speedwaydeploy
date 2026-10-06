// Automatic sign-out after inactivity: the timing rules, the limits per role, and that the guard is mounted.
//   node scripts/verify-idle-session.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { idleState } from '../frontend/src/utils/idleSession.js';
import { IDLE_LIMIT_MINUTES, IDLE_WARNING_SECONDS, idleLimitMinutesFor, LAST_ACTIVITY_KEY } from '../frontend/src/config/sessionPolicy.js';

const checks = [];
const check = (name, fn) => { try { fn(); checks.push([name, true]); } catch (e) { checks.push([name, false, e.message]); } };
const MIN = 60000;

check('every role is signed out after 60 minutes without activity', () => {
  for (const role of ['ADMIN', 'STAFF', 'CUSTOMER']) assert.equal(IDLE_LIMIT_MINUTES[role], 60);
  assert.equal(idleLimitMinutesFor('staff'), IDLE_LIMIT_MINUTES.STAFF);
  assert.equal(idleLimitMinutesFor(undefined), IDLE_LIMIT_MINUTES.CUSTOMER);
});
const limit = IDLE_LIMIT_MINUTES.ADMIN * MIN;
const warn = IDLE_WARNING_SECONDS * 1000;
const t0 = 1_000_000_000_000;
check('recent activity is active', () => assert.equal(idleState(t0 + 5 * MIN, t0, limit, warn).state, 'active'));
check('just before the warning is still active', () => assert.equal(idleState(t0 + limit - warn - 1, t0, limit, warn).state, 'active'));
check('the warning starts 60 seconds before the end', () => {
  const r = idleState(t0 + limit - warn, t0, limit, warn);
  assert.equal(r.state, 'warning'); assert.equal(r.secondsLeft, 60);
});
check('the warning counts down', () => assert.equal(idleState(t0 + limit - 10000, t0, limit, warn).secondsLeft, 10));
check('the session ends at the limit', () => assert.equal(idleState(t0 + limit, t0, limit, warn).state, 'expired'));
check('a device that slept past the limit ends at once, with no warning', () => assert.equal(idleState(t0 + limit * 3, t0, limit, warn).state, 'expired'));
check('activity in another tab (a newer time) resets it', () => assert.equal(idleState(t0 + limit - 5000, t0 + limit - 4000, limit, warn).state, 'active'));
check('a missing last-activity time never signs the user out', () => assert.equal(idleState(t0, 0, limit, warn).state, 'active'));

const guard = fs.readFileSync('frontend/src/components/IdleSessionGuard.jsx', 'utf8');
const main = fs.readFileSync('frontend/src/main.jsx', 'utf8');
const login = fs.readFileSync('frontend/src/pages/Login.jsx', 'utf8');
check('the guard is mounted for the whole app', () => assert.ok(/<IdleSessionGuard \/>/.test(main)));
check('the guard shares activity between tabs', () => assert.ok(guard.includes(LAST_ACTIVITY_KEY) || /LAST_ACTIVITY_KEY/.test(guard)));
check('administrator and staff sign-outs are audited', () => assert.ok(/record_idle_signout/.test(guard)));
check('the login page explains the automatic sign-out', () => assert.ok(/reason/.test(login) && /idle/.test(login)));
check('the migration records the sign-out for administrator and staff only', () => {
  const sql = fs.readFileSync('supabase/migrations/20261119000001_idle_signout_audit.sql', 'utf8');
  assert.ok(/not in \('ADMIN', 'STAFF'\)/.test(sql));
});

let failed = 0;
for (const [name, ok, why] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (${why})`}`); if (!ok) failed += 1; }
console.log(`\n${checks.length - failed}/${checks.length} idle sign-out checks passed.`);
process.exit(failed ? 1 : 0);
