/**
 * Which auth users have NO profiles row?
 *
 * requireAdmin reads the ROLE from `profiles`. If the signed-in auth user has no
 * profiles row, the lookup returns nothing and the route 403s — regardless of
 * what role the account was created with.
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

(async () => {
  const profRes = await fetch(`${URL}/rest/v1/profiles?select=id,email,role&limit=500`, { headers: H });
  const profiles = await profRes.json();
  const byId = new Map(profiles.map((p) => [p.id, p]));

  const userRes = await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers: H });
  const users = (await userRes.json()).users || [];

  console.log(`auth users: ${users.length} | profiles: ${profiles.length}\n`);
  console.log('=== auth users WITHOUT a profiles row (these will always 403) ===');
  let orphanCount = 0;
  for (const u of users) {
    if (!byId.has(u.id)) {
      orphanCount += 1;
      const metaRole = u.user_metadata?.role;
      console.log(
        `  ${u.email || '(no email)'} | id=${u.id.slice(0, 8)}… | metadata.role=${JSON.stringify(metaRole)} | confirmed=${Boolean(u.email_confirmed_at)} | last_sign_in=${u.last_sign_in_at || 'never'}`
      );
    }
  }
  if (!orphanCount) console.log('  (none)');

  console.log('\n=== auth users WITH a profiles row ===');
  for (const u of users) {
    const p = byId.get(u.id);
    if (p) {
      console.log(`  ${u.email} | profile.role=${JSON.stringify(p.role)} | metadata.role=${JSON.stringify(u.user_metadata?.role)}`);
    }
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });