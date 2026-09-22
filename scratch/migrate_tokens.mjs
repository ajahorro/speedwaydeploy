/**
 * Step 7.4 — mechanical token migration.
 *
 * Replaces hardcoded theme colours with their native CSS token equivalents
 * across the app source. Deliberately EXCLUDES:
 *   - pages/Landing.jsx      (always-dark marketing page, its own palette)
 *   - utils/logger.js        (console styling, not UI)
 *   - config/constants.js    (chart palette; recharts needs concrete colours)
 *   - CustomerReceipt.jsx / OfficialReceipt / print docs (must stay black-on-white)
 *
 * Safe, narrow substitutions only — no structural changes.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = new URL('../frontend/src/', import.meta.url);
const EXCLUDE = [
  'pages\\Landing.jsx', 'utils\\logger.js', 'config\\constants.js',
  // Print/receipt documents intentionally stay black-on-white regardless of theme.
  'components\\OfficialReceipt.jsx', 'pages\\Customer\\CustomerReceipt.jsx',
];

// Ordered pairs. Longer/more specific first.
const REPLACEMENTS = [
  // Dark surfaces -> themed tokens
  ["background: '#0A0B0D'", "background: 'var(--admin-bg)'"],
  ["background: '#15171A'", "background: 'var(--admin-card)'"],
  ["background: '#0F1012'", "background: 'var(--admin-sidebar)'"],
  ["background: '#1A1C20'", "background: 'var(--admin-input-bg)'"],
  // Brand
  ["background: '#E61E2A'", "background: 'var(--admin-brand)'"],
  ["color: '#E61E2A'", "color: 'var(--admin-brand)'"],
  ['color="#E61E2A"', 'color="var(--admin-brand)"'],
  ['color="#10b981"', 'color="var(--status-success)"'],
  ['color="#ef4444"', 'color="var(--status-danger)"'],
  ['color="#f59e0b"', 'color="var(--status-warning)"'],
  // Status text/fills
  ["background: '#ef4444'", "background: 'var(--status-danger)'"],
  ["background: '#10b981'", "background: 'var(--status-success)'"],
  ["color: '#ef4444'", "color: 'var(--status-danger)'"],
  ["color: '#10b981'", "color: 'var(--status-success)'"],
  ["color: '#f59e0b'", "color: 'var(--status-warning)'"],
  // Secondary text
  ["color: '#8E9196'", "color: 'var(--admin-text-secondary)'"],
  ["color: '#64748b'", "color: 'var(--admin-text-secondary)'"],
  ["color: '#9ca3af'", "color: 'var(--admin-text-secondary)'"],
  // White-on-brand / plain white text
  ["color: 'white'", "color: 'var(--admin-text-primary)'"],
  ["color: '#fff'", "color: 'var(--admin-text-on-brand)'"],
  // Common borders that assumed the dark theme
  ["border: '1px solid rgba(255, 255, 255, 0.05)'", "border: '1px solid var(--admin-border)'"],
  ["border: '1px solid rgba(255,255,255,0.05)'", "border: '1px solid var(--admin-border)'"],
  ["borderTop: '1px solid rgba(255, 255, 255, 0.05)'", "borderTop: '1px solid var(--admin-border)'"],
  ["borderBottom: '1px solid rgba(255, 255, 255, 0.05)'", "borderBottom: '1px solid var(--admin-border)'"],
  ["borderRight: '1px solid rgba(255, 255, 255, 0.05)'", "borderRight: '1px solid var(--admin-border)'"],
  ["border: '1px solid rgba(255, 255, 255, 0.1)'", "border: '1px solid var(--admin-input-border)'"],
];

const walk = (dir) => {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
};

const files = walk(SRC.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let totalFiles = 0, totalEdits = 0;
const report = [];

for (const file of files) {
  const rel = path.relative(SRC.pathname.replace(/^\/([A-Za-z]:)/, '$1'), file);
  if (EXCLUDE.some((x) => rel.endsWith(x))) continue;
  let src = fs.readFileSync(file, 'utf8');
  let edits = 0;
  for (const [from, to] of REPLACEMENTS) {
    if (src.includes(from)) {
      const count = src.split(from).length - 1;
      src = src.split(from).join(to);
      edits += count;
    }
  }
  if (edits > 0) {
    fs.writeFileSync(file, src, 'utf8');
    totalFiles++;
    totalEdits += edits;
    report.push(`${edits}\t${rel}`);
  }
}
console.log(`Files changed: ${totalFiles}, replacements: ${totalEdits}\n`);
console.log(report.sort().join('\n'));