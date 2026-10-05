// Builds the Supabase half of the staging environment in one go (the Vercel and Render halves are
// dashboard steps, see docs/STAGING.md).
//
//   node scripts/staging/create-staging.mjs --email-base you@gmail.com            create the project, then everything below
//   node scripts/staging/create-staging.mjs --email-base you@gmail.com --ref abc  use a project you already created
//   node scripts/staging/create-staging.mjs --dry-run ...                         print the steps only
//
// Steps: create project (unless --ref) -> wait until healthy -> apply every migration -> deploy the
// edge functions -> seed accounts and shop config -> write the environment values to
// .staging-secrets/ (gitignored). The production link is restored afterwards, whatever happens.
// Needs a free Supabase project slot: the free plan allows 2 active projects per account.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const PRODUCTION_REF = 'nsmytxlaidmndtqxctrw';
const ORG_ID = process.env.SUPABASE_ORG_ID || 'bwwgempmqqnstwicpwnb';
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const dry = process.argv.includes('--dry-run');
const emailBase = arg('--email-base');
let ref = arg('--ref');
const isWin = process.platform === 'win32';

if (!emailBase) { console.error('Pass --email-base you@example.com (alpha accounts use plus-addressing on it).'); process.exit(2); }
if (ref === PRODUCTION_REF) { console.error('--ref is the PRODUCTION project. Refusing.'); process.exit(2); }

const run = (label, command, args, options = {}) => {
  console.log(`\n▶ ${label}`);
  if (dry) { console.log(`  (dry run) ${command} ${args.join(' ').replace(/(--db-password |-p )\S+/g, '$1***')}`); return { status: 0, stdout: '', stderr: '' }; }
  const result = spawnSync(command, args, { encoding: 'utf8', shell: isWin && command === 'npx', ...options });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) { console.error(out.slice(-1200)); throw new Error(`${label} failed`); }
  return result;
};

fs.mkdirSync('.staging-secrets', { recursive: true });
const passwordFile = '.staging-secrets/db-password.txt';
let password = fs.existsSync(passwordFile) ? fs.readFileSync(passwordFile, 'utf8').trim() : null;

try {
  if (!ref) {
    if (!password) {
      password = `Stg-${Buffer.from(Array.from({ length: 18 }, () => Math.floor(Math.random() * 256))).toString('base64url')}`;
      if (!dry) fs.writeFileSync(passwordFile, password + '\n');
    }
    const created = run('create the staging project', 'supabase', ['projects', 'create', 'comar-garage-staging', '--org-id', ORG_ID, '--db-password', password, '--region', 'ap-southeast-1', '-o', 'json']);
    ref = (created.stdout.match(/"(?:ref|id)"\s*:\s*"([a-z0-9]{20})"/) || [])[1];
    if (!ref && !dry) throw new Error('could not read the new project ref from the CLI output');
  }
  if (!password && !dry) throw new Error(`the database password is needed in ${passwordFile} (the one set when the project was created)`);

  if (!dry) {
    for (let i = 0; i < 40; i += 1) {
      const list = spawnSync('supabase', ['projects', 'list', '-o', 'json'], { encoding: 'utf8' }).stdout || '';
      if (new RegExp(`"ref":"${ref}"[^}]*?"status":"ACTIVE_HEALTHY"`).test(list.replace(/\s+/g, ''))) break;
      if (i === 39) throw new Error('the staging project did not become healthy in time');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    }
  }

  run('link the CLI to staging', 'supabase', ['link', '--project-ref', ref || '<staging-ref>', '-p', password || '***']);
  run('apply every migration to staging', 'supabase', ['db', 'push', '--linked'], { input: 'Y\n' });
  run('deploy the edge functions to staging', 'supabase', ['functions', 'deploy', 'booking-lifecycle', 'send-notification-email', 'send-refund-receipt', 'send-status-email', '--project-ref', ref || '<staging-ref>', '--no-verify-jwt']);

  const keys = run('read the API keys', 'supabase', ['projects', 'api-keys', '--project-ref', ref || '<staging-ref>', '-o', 'json']);
  if (!dry) {
    const list = JSON.parse(keys.stdout.slice(keys.stdout.indexOf('[')));
    const anon = list.find((k) => k.name === 'anon')?.api_key;
    const service = list.find((k) => k.name === 'service_role')?.api_key;
    const url = `https://${ref}.supabase.co`;
    run('seed accounts and the shop configuration', 'node', ['scripts/staging/seed-staging.mjs', '--email-base', emailBase], { env: { ...process.env, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: service } });
    fs.writeFileSync('.staging-secrets/env.txt', [
      '# Staging environment values (private).',
      '# Vercel (staging deployment):', `VITE_SUPABASE_URL=${url}`, `VITE_SUPABASE_ANON_KEY=${anon}`, 'VITE_BACKEND_URL=<your staging Render URL>',
      '# Render (staging service):', `SUPABASE_URL=${url}`, `SUPABASE_SERVICE_ROLE_KEY=${service}`, 'FRONTEND_URL=<your staging Vercel URL>',
      '# Supabase dashboard -> Authentication -> URL configuration: set Site URL and add the staging Vercel URL to Redirect URLs.', ''
    ].join('\n'));
    console.log('\nEnvironment values written to .staging-secrets/env.txt. Next: the Vercel and Render steps in docs/STAGING.md.');
  }
} finally {
  // never leave the CLI pointed at staging
  if (!dry) spawnSync('supabase', ['link', '--project-ref', PRODUCTION_REF], { encoding: 'utf8' });
  console.log(dry ? '\n(dry run finished; nothing was changed)' : '\nProduction link restored.');
}
