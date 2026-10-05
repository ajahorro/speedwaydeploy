// Seeds a STAGING (or scratch) Supabase project with the alpha test accounts and a working shop config.
//
//   SUPABASE_URL=https://<staging-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/staging/seed-staging.mjs --email-base you@gmail.com [--out .staging-secrets/accounts.txt]
//
// Accounts use plus-addressing on the base address (you+alpha-admin@gmail.com ...), so every email the
// system sends lands in one mailbox you control. Passwords are random, written ONLY to the --out file
// (gitignored folder), never printed. Re-running keeps existing accounts and rewrites nothing they own.
//
// Refuses to run against the production project.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PRODUCTION_REF = 'nsmytxlaidmndtqxctrw';
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const emailBase = arg('--email-base');
const outFile = arg('--out') || '.staging-secrets/accounts.txt';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !emailBase || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailBase)) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and pass --email-base you@example.com');
  process.exit(2);
}
if (SUPABASE_URL.includes(PRODUCTION_REF)) {
  console.error('Refusing to seed the production project.');
  process.exit(2);
}

const [local, domain] = emailBase.split('@');
const plus = (tag) => `${local}+${tag}@${domain}`;
const api = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
  const response = await fetch(`${SUPABASE_URL}${pathname}`, {
    method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: response.ok, status: response.status, json, text };
};

const ACCOUNTS = [
  { tag: 'alpha-admin', role: 'ADMIN', first: 'Alpha', last: 'Admin', phone: '09170000001' },
  { tag: 'alpha-staff1', role: 'STAFF', first: 'Alpha', last: 'Technician One', phone: '09170000002' },
  { tag: 'alpha-staff2', role: 'STAFF', first: 'Alpha', last: 'Technician Two', phone: '09170000003' },
  { tag: 'alpha-customer1', role: 'CUSTOMER', first: 'Alpha', last: 'Customer One', phone: '09170000004' },
  { tag: 'alpha-customer2', role: 'CUSTOMER', first: 'Alpha', last: 'Customer Two', phone: '09170000005' }
];

const password = () => `Aa1!${crypto.randomBytes(12).toString('base64url')}`;
const lines = ['Comar Garage staging accounts (keep this file private)', `Created ${new Date().toISOString()}`, ''];

// ── shop configuration: a fresh project has no business_config row ──────────
const config = await api('/rest/v1/business_config?select=id&order=id&limit=1');
if (!config.ok) { console.error('Cannot read business_config:', config.status, config.text.slice(0, 200)); process.exit(1); }
if (!Array.isArray(config.json) || config.json.length === 0) {
  const created = await api('/rest/v1/business_config', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: {
      business_name: 'COMAR GARAGE (STAGING)', opening_hour: '08:00 AM', closing_hour: '06:00 PM', is_24_7: false,
      slots_per_hour: 3, max_vehicles_per_staff: 4, booking_lead_time_minutes: 5, max_advance_days: 60, closed_weekdays: [],
      enforce_capacity: true, vehicle_types: ['Sedan', 'SUV', 'Van/L300', 'Regular', 'Bigbike']
    }
  });
  console.log(created.ok ? 'created the shop configuration row' : `could not create the shop configuration (${created.status}): ${created.text.slice(0, 200)}`);
} else {
  console.log('shop configuration already exists (left unchanged)');
}

// ── accounts ───────────────────────────────────────────────────────────────
for (const account of ACCOUNTS) {
  const email = plus(account.tag);
  const pw = password();
  const created = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: { email, password: pw, email_confirm: true, user_metadata: { first_name: account.first, last_name: account.last, phone_number: account.phone, role: account.role } }
  });
  let userId = created.json?.id;
  let note = 'created';
  if (!created.ok) {
    if (!/already|registered|exists/i.test(created.text)) { console.error(`${email}: ${created.status} ${created.text.slice(0, 160)}`); continue; }
    const found = await api(`/auth/v1/admin/users?per_page=200`);
    userId = (found.json?.users || []).find((u) => u.email === email)?.id;
    note = 'already existed (password unchanged)';
  }
  if (!userId) continue;

  // the profile row (a trigger usually makes it; make sure it exists and has the right role)
  const profile = await api(`/rest/v1/profiles?select=id,role&id=eq.${userId}`);
  const row = { id: userId, email, role: account.role, first_name: account.first, last_name: account.last, full_name: `${account.first} ${account.last}`, phone_number: account.phone, is_active: true, must_change_password: false };
  if (!profile.json?.length) await api('/rest/v1/profiles', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: row });
  else if (profile.json[0].role !== account.role) await api(`/rest/v1/profiles?id=eq.${userId}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { role: account.role } });

  lines.push(`${account.role.padEnd(8)} ${email}${note === 'created' ? `   password: ${pw}` : `   (${note})`}`);
  console.log(`${account.role.padEnd(8)} ${email}  ${note}`);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
// Never overwrite: an earlier run's passwords are the only copy. Later runs only add new lines.
const createdLines = lines.filter((line) => /password: /.test(line));
if (!fs.existsSync(outFile)) fs.writeFileSync(outFile, lines.join('\n') + '\n');
else if (createdLines.length) fs.appendFileSync(outFile, '\n' + createdLines.join('\n') + '\n');
console.log(`\nPasswords for newly created accounts are in ${outFile} (not printed).`);
