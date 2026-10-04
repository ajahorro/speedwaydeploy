#!/usr/bin/env node
/**
 * Guardrail: booking money has ONE source of truth — the database ledger
 * (payment_ledger_v / booking_ledger_v, migration 20261024000003).
 *
 * Fails when application code reintroduces its own money math:
 *   - summing payment rows (`.reduce(` over payments / p.amount)
 *   - hard-coded downpayment tiers (30% / 50% at ₱2,000)
 *   - the removed JS ledger helpers
 *
 * Run: node scripts/verify-single-source.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SCAN = [
  { dir: 'frontend/src', exts: ['.js', '.jsx', '.ts', '.tsx'] },
  { dir: 'backend', exts: ['.js'], skip: ['node_modules'] }
];

// Files allowed to keep legacy logic for one release (documented fallbacks).
const ALLOWLIST = new Set([
  'frontend/src/pages/Admin/AdminSalesReport.jsx' // classic report at /admin/finance/classic
]);

const RULES = [
  {
    name: 'payment rows summed in application code',
    pattern: /payments?\b[^\n;]{0,160}\.reduce\(|\.reduce\([^\n]{0,120}\b(?:p|payment|pmt)\.amount\b/i,
    hint: 'Read booking_ledger_v / payment_ledger_v (services/ledgerService.js) instead.'
  },
  {
    name: 'hard-coded downpayment tier',
    pattern: />=\s*2000\s*\?\s*0?\.5|\?\s*0?\.5\s*:\s*0?\.3\b|\*\s*0\.3\b/,
    hint: 'Use booking_required_downpayment() or paymentUtils.calculateRequiredDownpayment (DB policy).'
  },
  {
    name: 'removed JS ledger helper',
    pattern: /\bcalculateNetPaid\b|\bcalculateVerifiedPaid\b|utils\/paymentAmounts/,
    hint: 'These were replaced by the database ledger.'
  }
];

const files = [];
const walk = (dir, exts, skip = []) => {
  for (const entry of readdirSync(dir)) {
    if (skip.includes(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, exts, skip);
    else if (exts.some((ext) => entry.endsWith(ext))) files.push(full);
  }
};
for (const { dir, exts, skip } of SCAN) walk(join(root, dir), exts, skip);

const violations = [];
for (const file of files) {
  const rel = relative(root, file).split(sep).join('/');
  if (ALLOWLIST.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/single-source-ok/.test(line)) return; // explicit, reviewed exception
    for (const rule of RULES) {
      if (rule.pattern.test(line)) violations.push({ rel, line: index + 1, rule, text: line.trim().slice(0, 140) });
    }
  });
}

if (violations.length) {
  console.error(`✖ ${violations.length} single-source violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  [${v.rule.name}]\n    ${v.text}\n    → ${v.rule.hint}`);
  }
  process.exit(1);
}
console.log(`✔ single source of truth: ${files.length} files checked, no violations.`);
