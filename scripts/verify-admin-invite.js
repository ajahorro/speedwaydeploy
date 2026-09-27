/**
 * End-to-end proof that an admin can invite.
 *
 * Signs in as the real admin (password from the env, never printed), then calls
 * POST /api/admin/invite-account against the DEPLOYED backend and reports the
 * status. Uses a deliberately invalid invite payload so the route proves it got
 * PAST the RBAC gate (400 "valid email required") without creating an account.
 */
const fs = require('fs');
const path = require('path');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const SUPA = env.SUPABASE_URL;
const ANON = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'testadmin961@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BACKEND = 'https://comargarage-backend.onrender.com';

if (!ADMIN_PASSWORD) {
  console.error('Set ADMIN_PASSWORD in the environment (it is not read from the repo).');
  process.exit(2);
}

(async () => {
  console.log(`signing in as ${ADMIN_EMAIL}…`);
  const signIn = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const session = await signIn.json();
  if (!session.access_token) {
    console.error(`sign-in failed (${signIn.status}): ${JSON.stringify(session).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`signed in OK. user id = ${session.user.id}`);

  const call = async (body, label) => {
    const res = await fetch(`${BACKEND}/api/admin/invite-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n${label}\n  -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return res.status;
  };

  // 1. Invalid email: proves we passed RBAC (403 would mean we did not).
  const s1 = await call({ email: 'not-an-email', role: 'STAFF' }, 'invalid email (expect 400 if RBAC passed)');
  // 2. Invalid role.
  const s2 = await call({ email: 'probe@example.com', role: 'WIZARD' }, 'invalid role (expect 400 if RBAC passed)');

  console.log('\n=== VERDICT ===');
  if (s1 === 403 || s2 === 403) {
    console.log('STILL 403 — the admin is still being rejected by RBAC.');
    process.exit(1);
  }
  console.log('RBAC PASSED — the admin reached the route body (400 = validation, not authorization).');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });