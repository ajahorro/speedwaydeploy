#!/usr/bin/env node
/**
 * sync-secrets.mjs — push shared secrets from backend/.env to Supabase secrets.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * backend/.env is the one authored copy of the email credentials. The Edge
 * Functions (send-refund-receipt, send-status-email, send-notification-email)
 * read the SAME values from Supabase secrets. This script copies them across so
 * the two can never drift — the exact failure that made the refund receipt
 * return `{"error":"API key is invalid"}`.
 *
 *   Values synced: RESEND_API_KEY, RESEND_FROM
 *
 * Usage:
 *   node scripts/sync-secrets.mjs            # sync (default project from config)
 *   node scripts/sync-secrets.mjs --dry-run  # show what would change
 *   node scripts/sync-secrets.mjs --project-ref <ref>
 *
 * Run automatically via:  npm run sync-secrets
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, 'backend', '.env');

// Secrets that live in Supabase for the Edge Functions but are authored in
// backend/.env. Keep this list in lockstep with the functions that read them.
const SHARED_KEYS = ['RESEND_API_KEY', 'RESEND_FROM'];

function parseEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const projectRefIdx = args.indexOf('--project-ref');
const projectRef =
  projectRefIdx !== -1 ? args[projectRefIdx + 1]
  : process.env.SUPABASE_PROJECT_REF || 'nsmytxlaidmndtqxctrw';

const env = parseEnv(envPath);
const pairs = [];
for (const key of SHARED_KEYS) {
  if (env[key]) pairs.push(`${key}=${env[key]}`);
  else console.warn(`⚠️  ${key} not found in backend/.env — skipping.`);
}

if (pairs.length === 0) {
  console.error('Nothing to sync. Add RESEND_API_KEY / RESEND_FROM to backend/.env first.');
  process.exit(1);
}

console.log(`Syncing ${pairs.length} secret(s) to Supabase project ${projectRef}:`);
for (const key of SHARED_KEYS) {
  if (env[key]) console.log(`  • ${key} = ${key === 'RESEND_API_KEY' ? env[key].slice(0, 8) + '…' + env[key].slice(-4) : env[key]}`);
}

if (dryRun) {
  console.log('\n--dry-run: no changes made.');
  process.exit(0);
}

try {
  // Write the secrets to a temp env file and let the CLI read it. This avoids
  // passing values through a shell, where `<`/`>` inside RESEND_FROM would be
  // treated as redirection.
  const tmpFile = path.join(repoRoot, `.secrets-sync.${process.pid}.env`);
  try {
    fs.writeFileSync(tmpFile, SHARED_KEYS.filter(k => env[k]).map(k => `${k}=${env[k]}`).join('\n') + '\n', 'utf8');

    // Invoke the CLI through `npm exec`, which resolves the supabase binary the
    // same way the earlier manual runs did — dodging the Windows `.cmd` spawn
    // trap entirely. A single command STRING (not an args array) avoids Node's
    // DEP0190 warning; every token is a fixed literal, and the secrets travel
    // in the env file (not the command line), so there is nothing to inject.
    const cmdLine = [
      'npm', 'exec', '--yes', '--', 'supabase', 'secrets', 'set',
      '--env-file', `"${tmpFile}"`, '--project-ref', projectRef
    ].join(' ');
    const result = execFileSync(cmdLine, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    if (result) process.stdout.write(result);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }

  console.log('\n✅ Supabase secrets updated. Redeploy functions if their code changed:');
  console.log('   npm run deploy-functions');
} catch (err) {
  if (err.stdout) process.stdout.write(String(err.stdout));
  if (err.stderr) process.stderr.write(String(err.stderr));
  console.error('\n❌ Failed to set secrets. Is the Supabase CLI installed and logged in?');
  console.error('   npx supabase login');
  process.exit(1);
}