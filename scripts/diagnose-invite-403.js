/**
 * Diagnose the invite-account 403.
 *
 * Queries the LIVE database for what requireAdmin actually sees, instead of
 * theorising about it. Reads only; changes nothing.
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', 'backend', '.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in backend/.env');
  process.exit(1);
}

const rest = async (pathname) => {
  const res = await fetch(`${URL}/rest/v1/${pathname}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
};

(async () => {
  console.log('=== profiles: every row with role mentioning admin (any case) ===');
  const all = await rest('profiles?select=id,email,role,is_active,full_name&limit=200');
  if (all.status !== 200) {
    console.log(`profiles query FAILED ${all.status}: ${all.text.slice(0, 400)}`);
  } else {
    const rows = all.json || [];
    console.log(`total profiles: ${rows.length}`);
    const interesting = rows.filter((r) => String(r.role || '').toUpperCase().includes('ADMIN'));
    if (!interesting.length) {
      console.log('!! NO profile has a role containing "admin" (any case).');
    }
    for (const r of interesting) {
      const roleRaw = JSON.stringify(r.role);
      const normalised = String(r.role || '').trim().toUpperCase();
      console.log(
        `  ${r.email || '(no email)'} | role=${roleRaw} normalised=${JSON.stringify(normalised)} | is_active=${JSON.stringify(r.is_active)} (${typeof r.is_active}) | passes=${normalised === 'ADMIN' && r.is_active !== false}`
      );
    }

    console.log('\n=== distinct role values across all profiles ===');
    const counts = new Map();
    for (const r of rows) {
      const k = `${JSON.stringify(r.role)} (${typeof r.role})`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v.toString().padStart(3)} × ${k}`);
    }

    console.log('\n=== is_active distribution ===');
    const active = new Map();
    for (const r of rows) {
      const k = `${JSON.stringify(r.is_active)} (${typeof r.is_active})`;
      active.set(k, (active.get(k) || 0) + 1);
    }
    for (const [k, v] of [...active.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v.toString().padStart(3)} × ${k}`);
    }
  }

  console.log('\n=== auth.users: do admin profile ids match real auth users? ===');
  const usersRes = await fetch(`${URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  const usersBody = await usersRes.text();
  try {
    const parsed = JSON.parse(usersBody);
    const users = parsed.users || [];
    console.log(`auth users: ${users.length}`);
    const adminProfiles = (all.json || []).filter((r) => String(r.role || '').toUpperCase() === 'ADMIN');
    for (const p of adminProfiles) {
      const match = users.find((u) => u.id === p.id);
      console.log(`  profile ${p.email}: auth user ${match ? `FOUND (${match.email})` : 'MISSING — orphaned profile row'}`);
    }
  } catch {
    console.log(`auth admin list failed: ${usersBody.slice(0, 300)}`);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });