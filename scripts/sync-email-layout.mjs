#!/usr/bin/env node
/**
 * The email layout lives in backend/services/emailLayout.js (Node) and is copied to
 * supabase/functions/_shared/emailLayout.ts (Supabase Edge Functions, Deno), so the backend emails and the booking
 * emails look exactly the same.
 *
 *   node scripts/sync-email-layout.mjs          write the .ts copy from the .js file
 *   node scripts/sync-email-layout.mjs --check  exit 1 if the copy is out of date (used by verify-all)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'backend/services/emailLayout.js');
const dest = path.join(root, 'supabase/functions/_shared/emailLayout.ts');

const js = fs.readFileSync(src, 'utf8');
const exportLine = /module\.exports = \{([^}]*)\};\s*$/;
if (!exportLine.test(js)) { console.error('emailLayout.js must end with a single module.exports = { ... } line.'); process.exit(1); }
const ts = `// @ts-nocheck\n// GENERATED from backend/services/emailLayout.js by scripts/sync-email-layout.mjs. Do not edit here.\n${js.replace(exportLine, (_, names) => `export {${names}};\n`)}`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
  if (current !== ts) { console.error('supabase/functions/_shared/emailLayout.ts is out of date. Run: node scripts/sync-email-layout.mjs'); process.exit(1); }
  console.log('email layout copy is up to date');
} else {
  fs.writeFileSync(dest, ts);
  console.log(`wrote ${path.relative(root, dest)}`);
}
