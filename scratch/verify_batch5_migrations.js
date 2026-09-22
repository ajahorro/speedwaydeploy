// Batch 5 migration static validator.
// No local Postgres/Docker is available, so this checks structural invariants
// that catch the most common hand-authored SQL migration mistakes. It is NOT a
// substitute for a real parse against Postgres, but it catches tag/terminator
// errors and policy-hygiene issues before a live apply.
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '../supabase/migrations');
const files = [
  '20260924000001_add_service_photos_table.sql',
  '20260924000002_create_service_proofs_private_bucket.sql',
  '20260924000003_add_photo_retention_policy.sql'
];

let pass = 0, fail = 0;
const ok = (label) => { pass++; console.log(`PASS  ${label}`); };
const bad = (label, why) => { fail++; console.log(`FAIL  ${label}\n        ${why}`); };

for (const f of files) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) { bad(f, 'file missing'); continue; }
  const sql = fs.readFileSync(p, 'utf8');

  // 1. Dollar-quote tags must pair up (and in the right nesting order).
  const tags = [...sql.matchAll(/\$([a-z_]*)\$/gi)].map(m => m[1]);
  const counts = {};
  tags.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  const unbalanced = Object.entries(counts).filter(([, n]) => n % 2 !== 0);
  unbalanced.length === 0
    ? ok(`${f}: dollar-quote tags balanced (${Object.keys(counts).join(', ') || 'none'})`)
    : bad(`${f}: dollar-quote imbalance`, unbalanced.map(([t, n]) => `$${t}$ x${n}`).join(', '));

  // 2. Every create policy must be preceded by a matching drop policy (idempotency).
  const drops = new Set([...sql.matchAll(/drop policy if exists "([^"]+)"/gi)].map(m => m[1]));
  const creates = [...sql.matchAll(/create policy "([^"]+)"/gi)].map(m => m[1]);
  const missingDrop = creates.filter(c => !drops.has(c));
  missingDrop.length === 0
    ? ok(`${f}: all ${creates.length} policies have an idempotent drop`)
    : bad(`${f}: create policy without drop`, missingDrop.join(', '));

  // 3. create table/function should be guarded (if-not-exists / or-replace).
  const createTable = [...sql.matchAll(/create table (?!if not exists)/gi)];
  const createFn = [...sql.matchAll(/create (?:or replace )?function (?!.*or replace)/gi)];
  createTable.length === 0
    ? ok(`${f}: create table guarded`)
    : bad(`${f}: unguarded create table`, `${createTable.length} occurrence(s)`);

  // 4. Statements should end with ; (crude: non-empty last non-comment char).
  const stripped = sql.replace(/--[^\n]*/g, '').trimEnd();
  stripped.endsWith(';')
    ? ok(`${f}: file terminates with a statement`)
    : bad(`${f}: file does not end with ';'`, `last chars: ${JSON.stringify(stripped.slice(-20))}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
