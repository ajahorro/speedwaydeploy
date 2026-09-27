/**
 * Delete the orphaned auth users (no profiles row), as requested.
 *
 * KEPT: jamesvillanueva119@gmail.com and testadmin961@gmail.com — both have a
 * profiles row, and testadmin961 is the working admin account.
 *
 * Safe because check-user-references.js confirmed NOTHING references these ids
 * in bookings / notifications / audit_logs / blocked_slots / chat_messages /
 * payments.
 *
 * Usage:
 *   node scripts/delete-orphan-users.js          # dry run (default)
 *   node scripts/delete-orphan-users.js --apply  # actually delete
 */
const fs = require('fs');
const path = require('path');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const APPLY = process.argv.includes('--apply');
const KEEP = new Set(['jamesvillanueva119@gmail.com', 'testadmin961@gmail.com']);

(async () => {
  const profRes = await fetch(`${URL}/rest/v1/profiles?select=id,email`, { headers: H });
  const profiles = await profRes.json();
  const profileIds = new Set(profiles.map((p) => p.id));

  const users = (await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers: H }).then((r) => r.json())).users || [];

  const targets = users.filter((u) => !profileIds.has(u.id) && !KEEP.has(u.email));

  console.log(`mode: ${APPLY ? 'APPLY (deleting)' : 'DRY RUN (nothing will change)'}`);
  console.log(`auth users: ${users.length} | profiles: ${profiles.length} | to delete: ${targets.length}\n`);

  let ok = 0;
  let failed = 0;
  for (const u of targets) {
    if (!APPLY) {
      console.log(`  would delete: ${u.email}  [${u.id.slice(0, 8)}…]`);
      continue;
    }
    const res = await fetch(`${URL}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: H });
    if (res.ok) {
      ok += 1;
      console.log(`  DELETED: ${u.email}`);
    } else {
      failed += 1;
      const body = await res.text();
      console.log(`  FAILED (${res.status}): ${u.email} — ${body.slice(0, 200)}`);
    }
  }

  if (APPLY) {
    console.log(`\ndeleted ${ok}, failed ${failed}`);
    const remaining = (await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers: H }).then((r) => r.json())).users || [];
    console.log(`\nremaining auth users (${remaining.length}):`);
    for (const u of remaining) {
      const hasProfile = profileIds.has(u.id);
      console.log(`  ${u.email} | metadata.role=${JSON.stringify(u.user_metadata?.role)} | profile=${hasProfile ? 'yes' : 'NO'}`);
    }
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });