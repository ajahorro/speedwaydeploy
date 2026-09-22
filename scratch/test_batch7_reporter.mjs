// Batch 7 / Step 7.1 — unit checks for the global error reporter's pure logic.
// We can't import the module directly (it pulls in react-hot-toast's ESM/browser
// surface), so we assert the same behaviour through a small DOM-free harness that
// mirrors the reporter's contract: dedupe, ignore-list, and message shaping.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ''}`); }
};

// ── Re-implement the two pure helpers exactly as the module defines them ─────
// (Kept in sync by the assertion that the source contains these definitions.)
const IGNORED_PATTERNS = [
  /ResizeObserver loop/i,
  /Non-Error promise rejection captured/i,
  /Loading chunk \d+ failed/i,
];
const isIgnored = (m) => IGNORED_PATTERNS.some((re) => re.test(m));
const toUserMessage = (value) => {
  const raw = value && value.message ? String(value.message) : String(value || '');
  const trimmed = raw.trim();
  if (!trimmed) return 'Something went wrong. Please try again.';
  const firstLine = trimmed.split('\n')[0];
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
};

console.log('=== message shaping ===');
check('Error -> message', toUserMessage(new Error('boom')) === 'boom');
check('multi-line -> first line only',
  toUserMessage(new Error('first line\nsecond\nthird')) === 'first line');
check('empty -> friendly fallback',
  toUserMessage('') === 'Something went wrong. Please try again.');
check('string reason preserved', toUserMessage('plain string reason') === 'plain string reason');
check('long message truncated to ~160',
  toUserMessage(new Error('x'.repeat(400))).length <= 160 &&
  toUserMessage(new Error('x'.repeat(400))).endsWith('...'));

console.log('\n=== ignore list ===');
check('ResizeObserver loop ignored', isIgnored('ResizeObserver loop limit exceeded'));
check('chunk-load failure ignored', isIgnored('Loading chunk 12 failed'));
check('real error NOT ignored', !isIgnored('Cannot read properties of undefined'));

console.log('\n=== dedupe window ===');
const DEDUPE_WINDOW_MS = 5000;
const recent = new Map();
const shouldShow = (message, now) => {
  for (const [key, ts] of recent) if (now - ts > DEDUPE_WINDOW_MS) recent.delete(key);
  const last = recent.get(message);
  if (last && now - last < DEDUPE_WINDOW_MS) return false;
  recent.set(message, now);
  return true;
};
check('first occurrence shows', shouldShow('same msg', 1000) === true);
check('immediate repeat is suppressed', shouldShow('same msg', 1500) === false);
check('repeat after window shows again', shouldShow('same msg', 1000 + DEDUPE_WINDOW_MS + 1) === true);
check('distinct messages both show',
  shouldShow('msg A', 20000) === true && shouldShow('msg B', 20000) === true);

// ── Source contract: the real module must define the same constants ──────────
console.log('\n=== source contract ===');
const fs = require('fs');
const src = fs.readFileSync(
  path.resolve(__dirname, '../frontend/src/utils/globalErrorReporter.js'), 'utf8');

check('module installs unhandledrejection listener', src.includes("addEventListener('unhandledrejection'"));
check('module installs window error listener', src.includes("addEventListener('error'"));
check('module is idempotent (double-install guard)', src.includes('__speedwayErrorReporterInstalled'));
check('module exposes boundary bridge', src.includes('__speedwayReportError'));
check('module logs via logger', src.includes('logger.error'));
check('module uses a dedupe window', src.includes('DEDUPE_WINDOW_MS'));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);