/**
 * One command for every local test script. It fills in the long arguments (the scratch database's address and keys, the
 * backend's address, the database container), starts the backend against the scratch database if it is not running,
 * makes sure the test accounts can sign in, runs the test, and stops the backend again if it started it.
 *
 *   node scripts/run-local-test.mjs tiers                 -> scripts/stress-tiers-local.mjs
 *   node scripts/run-local-test.mjs lifecycle --phases A,B,C,D,E,F
 *   node scripts/run-local-test.mjs stress | storage | retention | refund-proof
 *   node scripts/run-local-test.mjs verify-all
 *   node scripts/run-local-test.mjs scripts/some-other-test.mjs   (any script that takes --api/--anon/--service)
 *
 * It only ever talks to the local scratch stack (127.0.0.1), never to production. Docker Desktop and the local Supabase
 * stack (container "supabase_db_speedway-ledger-test") must be running.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.LOCAL_API || 'http://127.0.0.1:55421';
const BACKEND_PORT = 3999;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const DB = process.env.LOCAL_DB || 'supabase_db_speedway-ledger-test';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'; // the local stack's own demo secret

const SCRIPTS = {
  tiers: 'scripts/stress-tiers-local.mjs',
  lifecycle: 'scripts/stress-lifecycle-local.mjs',
  stress: 'scripts/stress-local.mjs',
  storage: 'scripts/storage-photo-local.mjs',
  retention: 'scripts/photo-retention-local.mjs',
  'refund-proof': 'scripts/refund-proof-local.mjs',
  'verify-all': 'scripts/verify-all.mjs'
};

const [target, ...extra] = process.argv.slice(2);
if (!target) {
  console.log(`Usage: node scripts/run-local-test.mjs <${Object.keys(SCRIPTS).join(' | ')} | path/to/script.mjs> [extra arguments]`);
  process.exit(2);
}
const script = SCRIPTS[target] || target;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (role) => {
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase-demo', role, exp: 1983812996 })}`;
  return `${data}.${crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url')}`;
};
const ANON = sign('anon');
const SERVICE = sign('service_role');

const fail = (text) => { console.error(`\n${text}\n`); process.exit(2); };

// 1. is the scratch stack there?
try {
  const r = await fetch(`${API}/auth/v1/health`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok && r.status !== 401) throw new Error(`status ${r.status}`);
} catch {
  fail(`The local Supabase stack is not answering at ${API}.\nStart Docker Desktop, then start the local stack (the "${DB}" container group), and run this again.`);
}
try { execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', 'select 1'], { stdio: 'pipe' }); }
catch { fail(`The database container "${DB}" is not running. Start Docker Desktop and the local stack, then run this again.`); }

// 2. test accounts that can sign in (the scripts sign in with this password)
const accounts = ['admin@test.local', 'cust@test.local', 'soa-customer@test.local', 'staff@test.local', 'real-staff@test.local'];
for (const email of accounts) {
  try {
    const id = execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', `select id from auth.users where email='${email}'`], { encoding: 'utf8' }).trim();
    if (!id) continue;
    await fetch(`${API}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'LocalTest-123', email_confirm: true }) });
  } catch { /* an account that does not exist is simply skipped */ }
}

// 3. the backend, started against the scratch database when it is not already up
const portOpen = () => new Promise((resolve) => {
  const s = net.connect(BACKEND_PORT, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
let backend = null;
if (!(await portOpen())) {
  console.log('Starting the backend against the local scratch database...');
  backend = spawn('node', ['server.js'], {
    cwd: path.join(root, 'backend'),
    env: {
      ...process.env,
      SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON, PORT: String(BACKEND_PORT),
      FRONTEND_URL: 'http://127.0.0.1:5183',
      // no real e-mail is ever sent from a test run
      RESEND_API_KEY: 're_local_disabled', RESEND_FROM: 'Local <local@test.local>', RESEND_SENDER_EMAIL: 'local@test.local'
    },
    stdio: 'ignore'
  });
  for (let i = 0; i < 40 && !(await portOpen()); i += 1) await new Promise((r) => setTimeout(r, 500));
  if (!(await portOpen())) { backend.kill(); fail('The backend did not start. Run "node server.js" inside the backend folder to see why.'); }
} else {
  console.log(`Using the backend already running on port ${BACKEND_PORT} (restart it first if you changed backend code).`);
}

// 4. run the test with every argument filled in
const args = [script, '--api', API, '--anon', ANON, '--service', SERVICE, '--backend', BACKEND, '--db', DB, ...extra];
const result = spawnSync('node', args, { cwd: root, stdio: 'inherit' });
if (backend) backend.kill();
process.exit(result.status ?? 1);
