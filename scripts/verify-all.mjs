// One command for the final verification (master plan Part 6):
//   node scripts/verify-all.mjs                 guard scripts + frontend build + backend syntax
//   node scripts/verify-all.mjs --db <container>  also the scratch-database suites (docker)
//   node scripts/verify-all.mjs --skip-build      skip the (slow) frontend build
// Exits non-zero if anything fails. Known, documented gaps are marked "KNOWN GAP" in the SQL suites
// and do not fail the run.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const dbIndex = args.indexOf('--db');
const container = dbIndex >= 0 ? args[dbIndex + 1] : null;
const skipBuild = args.includes('--skip-build');
const isWin = process.platform === 'win32';

const rows = [];
const run = (name, command, commandArgs, options = {}) => {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', shell: isWin && command === 'npx', ...options });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const ok = result.status === 0 && (options.check ? options.check(output) : true);
  rows.push({ name, ok, seconds: ((Date.now() - started) / 1000).toFixed(1), note: options.note ? options.note(output) : '' });
  if (!ok) console.error(`\n--- ${name} failed ---\n${output.slice(-1500)}`);
};

// ── guard scripts ──────────────────────────────────────────────────────────
for (const script of ['verify-single-source', 'verify-email-source', 'verify-email-links', 'verify-contact-rules', 'verify-shop-time', 'verify-statement-pdf', 'verify-ocr-parser']) {
  run(script, 'node', [`scripts/${script}.mjs`], { note: (out) => out.trim().split('\n').pop().slice(0, 70) });
}

// Catalog sync: static always; with a scratch database also the browser-vs-database property test.
run(
  `verify-catalog-sync${container ? ' (+db)' : ''}`,
  'node',
  ['scripts/verify-catalog-sync.mjs', ...(container ? ['--db', container] : [])],
  { note: (out) => out.trim().split('\n').pop().slice(0, 80) }
);

// ── syntax of every backend file that changed shape recently ───────────────
for (const file of ['backend/server.js', 'backend/services/analyticsAssistant.js', 'backend/services/analyticsBuiltIn.js', 'backend/services/scheduleValidation.js']) {
  run(`syntax ${file.replace('backend/', '')}`, 'node', ['--check', file]);
}

// ── frontend production build, then a check that the Tailwind utilities of Tailwind-only pages exist ──
if (!skipBuild) {
  run('frontend build', 'npx', ['vite', 'build'], { cwd: 'frontend' });
  const assets = fs.existsSync('frontend/dist/assets') ? fs.readdirSync('frontend/dist/assets').filter((f) => f.endsWith('.css')) : [];
  const css = assets.map((f) => fs.readFileSync(`frontend/dist/assets/${f}`, 'utf8')).join('\n');
  for (const needle of ['border-l-\\[3px\\]', 'min-w-5']) {
    rows.push({ name: `css has ${needle.replace(/\\/g, '')} (Tailwind-only pages)`, ok: css.includes(needle), seconds: '0.0', note: '' });
  }
}

// ── scratch database suites ────────────────────────────────────────────────
if (container) {
  const suites = [
    ['sql: hub propagation', 'scripts/sql/verify-hub-propagation.sql', /^\s*\S.*\|\s*FAIL\s*\|(?!.*KNOWN GAP)/m, /KNOWN GAP/],
    ['sql: balance payment', 'scripts/sql/verify-balance-payment.sql', /\|\s*FAIL\s*\|/m, null],
    ['sql: pricing guard', 'scripts/sql/verify-pricing-guard.sql', /\|\s*FAIL\s*\|/m, null],
    ['sql: per-vehicle technicians', 'scripts/sql/verify-per-vehicle-technicians.sql', /\|\s*FAIL\s*\|/m, null],
    ['sql: staff reports', 'scripts/sql/verify-staff-report.sql', /\|\s*FAIL\s*\|/m, null]
  ];
  for (const [name, file, failPattern] of suites) {
    const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres'], { input: fs.readFileSync(file), encoding: 'utf8' });
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    const failLines = out.split('\n').filter((line) => /\|\s*FAIL\s*\|/.test(line) && !/KNOWN GAP/.test(line));
    const passes = out.split('\n').filter((line) => /\|\s*PASS\s*\|/.test(line)).length;
    const ok = result.status === 0 && passes > 0 && failLines.length === 0;
    rows.push({ name, ok, seconds: '-', note: `${passes} pass` });
    if (!ok) console.error(`\n--- ${name} failed ---\n${failLines.join('\n') || out.slice(-800)}`);
  }
}

console.log('\n' + rows.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(46)} ${String(r.seconds).padStart(6)}s  ${r.note}`).join('\n'));
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} checks passed.`);
process.exit(failed ? 1 : 0);
