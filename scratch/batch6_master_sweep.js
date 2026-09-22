// Batch 6 master sweep — runs every Batch 6 verification harness in sequence
// and reports a single unified pass/fail. This is the one command the brief's
// "run the master sweep" step refers to.
//
//   node scratch/batch6_master_sweep.js
//
// Covers:
//   1. pglite_batch6.js          — migration applied to real (WASM) Postgres
//   2. test_batch6_rules.mjs     — pure rules engine unit assertions
//   3. test_batch6_validation.mjs— server validator decisions (fake DB)
//   4. test_batch6_http.cjs      — real Express routes over HTTP
//   5. verify_batches.js         — static "everything still exists" ledger (B1-B6)
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const suites = [
  ['Migration @ PGlite (real Postgres)', ['scratch/pglite_batch6.js'], 'node'],
  ['Pure rules engine (unit)',           ['scratch/test_batch6_rules.mjs'], 'node'],
  ['Server validator (unit)',            ['scratch/test_batch6_validation.mjs'], 'node'],
  ['Endpoints over HTTP (integration)',  ['scratch/test_batch6_http.cjs'], 'node'],
  ['Static ledger (B1-B6 regression)',   ['scratch/verify_batches.js'], 'node'],
];

const run = (args) => spawnSync('node', args, { cwd: root, encoding: 'utf8' });

let failed = 0;
console.log('=== BATCH 6 MASTER SWEEP =====================================\n');
for (const [label, args] of suites) {
  const res = run(args);
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  // Pull the harness's own summary line if present, else the exit code.
  const summary = (out.match(/===.*passed.*===\s*$/m) || [])[0]
    || (out.match(/===\s*\d+\s*passed,\s*\d+\s*failed\s*===/g) || []).pop()
    || '';
  const ok = res.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)} ${summary.trim()}`);
  if (!ok) {
    // Surface the tail so a failure is diagnosable without re-running manually.
    console.log('  ---- output tail ----');
    console.log(out.split('\n').slice(-12).map((l) => `  ${l}`).join('\n'));
  }
}

console.log(`\n=== ${suites.length - failed}/${suites.length} suites passed ===`);
process.exit(failed === 0 ? 0 : 1);