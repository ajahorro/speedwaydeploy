/**
 * Before deleting orphaned auth users, check whether anything REFERENCES them.
 * A blind delete would either fail on a foreign key or silently orphan bookings.
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

const rest = async (q) => {
  const r = await fetch(`${URL}/rest/v1/${q}`, { headers: H });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _raw: t, _status: r.status }; }
};

// KEEP: jamesvillanueva119 has a profile. KEEP: testadmin961 (the working admin).
// Everything else without a profile is a candidate.
const CANDIDATES = [
  'jamesvillanueva1119@gmail.com', 'zette_1108@yahoo.com', 'elwyndev02@uberip.com',
  'marvs933@gmail.com', 'mvpefiles@gmail.com', 'mailprobe.1790107821874@speedway-test.dev',
  'uitest.staff.1790107732364@speedway-test.dev', 'speedwaytest.admin.1790107095477@example.com',
  'speedwaytest.staff.1790107095477@example.com', 'speedwaytest.admin.1790106998663@example.com',
  'speedwaytest.staff.1790106998663@example.com', 'jayneahorro@gmail.com', 'customer@gmail.com',
  'staff2@speedway.com', 'staff1@speedway.com', 'admin@speedway.com',
];

(async () => {
  const users = (await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers: H }).then((r) => r.json())).users || [];
  const byEmail = new Map(users.map((u) => [u.email, u]));

  console.log('=== reference check for each candidate ===\n');
  const tables = [
    ['bookings', 'customer_id'],
    ['bookings', 'staff_id'],
    ['notifications', 'user_id'],
    ['audit_logs', 'actor_id'],
    ['blocked_slots', 'created_by'],
    ['chat_messages', 'sender_id'],
    ['payments', 'verified_by'],
  ];

  for (const email of CANDIDATES) {
    const u = byEmail.get(email);
    if (!u) { console.log(`${email}: NOT FOUND (already gone?)`); continue; }
    const refs = [];
    for (const [table, col] of tables) {
      try {
        const rows = await rest(`${table}?select=id&${col}=eq.${u.id}&limit=1`);
        if (Array.isArray(rows) && rows.length) refs.push(`${table}.${col}`);
        else if (rows && rows._status && rows._status >= 400) refs.push(`${table}.${col}(?)`);
      } catch { /* column may not exist */ }
    }
    console.log(`${email}  [${u.id.slice(0, 8)}…]  metadata.role=${JSON.stringify(u.user_metadata?.role)}  refs: ${refs.length ? refs.join(', ') : 'NONE'}`);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });