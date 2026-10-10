/**
 * Collects every piece of visible English text in the frontend source, so it can be translated once and kept in
 * frontend/src/i18n/tl.json. Nothing in the components is edited by hand: run this after changing text, translate what
 * is reported as missing, and the language switch picks it up.
 *
 *   node scripts/i18n-extract.mjs            report how many strings are new / untranslated
 *   node scripts/i18n-extract.mjs --write    also write scripts/.i18n-report/source.json and missing.json
 *
 * Template strings keep their variables as {} (for example "Booked on {}"), and the runtime matches them the same way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const require = createRequire(path.join(root, 'frontend', 'package.json'));
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const SRC = path.join(root, 'frontend', 'src');
const OUT_DIR = path.join(SRC, 'i18n');
const SKIP_DIRS = new Set(['i18n', 'node_modules']);

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name)); continue; }
    if (/\.(jsx?|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(path.join(dir, entry.name));
  }
};
walk(SRC);

const UI_ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'helperText', 'description', 'message', 'confirmText', 'cancelText', 'emptyText', 'heading', 'subtitle', 'badge', 'tooltip', 'text']);
const UI_KEYS = new Set(['title', 'message', 'label', 'desc', 'description', 'text', 'confirmText', 'cancelText', 'placeholder', 'helper', 'hint', 'error', 'subtitle', 'badge', 'heading', 'summary', 'tagline', 'name']);
const found = new Set();

const clean = (value) => String(value).replace(/\s+/g, ' ').trim();
const looksLikeText = (value, strict) => {
  if (!value || value.length < 2 || value.length > 240) return false;
  if (!/[A-Za-z]{2}/.test(value)) return false;
  if (/^(https?:|\/|\.|#|--|@|data:|rgba?\(|var\()/.test(value)) return false;
  if (/[{}<>]|=>|\\|\$\(|^\w+\(/.test(value.replace(/\{\}/g, ''))) return false;
  if (/^[a-z0-9_.-]+$/.test(value)) return false;            // identifiers, class names, ids
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(value)) return false;  // camelCase tokens
  if (/^[A-Z0-9_]+$/.test(value) && value.includes('_')) return false; // SNAKE_CASE constants
  const tokens = value.split(' ');
  if (tokens.length > 1 && tokens.every((t) => /^!?-?[a-z][a-z0-9:/.%_[]#()-]*$/.test(t)) && tokens.some((t) => /[-:![]/.test(t))) return false; // class lists
  if (/^(English|Filipino (Tagalog))$/.test(value)) return false; // language names stay as they are
  if (!strict) return true;
  return /^[A-Z]/.test(value) && /\s/.test(value); // outside obvious UI places: only sentences / phrases
};
const add = (value, strict) => { const text = clean(value); if (looksLikeText(text, strict)) found.add(text); };
const templateText = (node) => node.quasis.map((q, i) => q.value.cooked + (i < node.expressions.length ? '{}' : '')).join('');

for (const file of files) {
  let ast;
  try {
    ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true });
  } catch { continue; }
  traverse(ast, {
    JSXText(p) { add(p.node.value, false); },
    JSXAttribute(p) {
      const name = p.node.name?.name;
      const v = p.node.value;
      if (!UI_ATTRS.has(name) || !v) return;
      if (v.type === 'StringLiteral') add(v.value, false);
      else if (v.type === 'JSXExpressionContainer' && v.expression.type === 'StringLiteral') add(v.expression.value, false);
      else if (v.type === 'JSXExpressionContainer' && v.expression.type === 'TemplateLiteral') add(templateText(v.expression), false);
    },
    ObjectProperty(p) {
      const key = p.node.key?.name || p.node.key?.value;
      const v = p.node.value;
      if (!UI_KEYS.has(key)) return;
      if (v.type === 'StringLiteral') add(v.value, false);
      else if (v.type === 'TemplateLiteral') add(templateText(v), false);
    },
    StringLiteral(p) {
      if (p.parent.type === 'ImportDeclaration' || p.parent.type === 'ExportNamedDeclaration' || p.parent.type === 'ExportAllDeclaration') return;
      if (p.parent.type === 'ObjectProperty' && p.parent.key === p.node) return;
      if (p.parent.type === 'JSXAttribute') return;
      add(p.node.value, true);
    },
    TemplateLiteral(p) {
      if (p.parent.type === 'TaggedTemplateExpression') return;
      add(templateText(p.node), true);
    }
  });
}

const all = [...found].sort((a, b) => a.localeCompare(b));
let translated = {};
try { translated = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'tl.json'), 'utf8')); } catch { /* no catalog yet */ }
const missing = all.filter((s) => !(s in translated));
console.log(`${all.length} strings found in ${files.length} files; ${all.length - missing.length} translated, ${missing.length} missing.`);
if (process.argv.includes('--write')) {
  const reportDir = path.join(root, 'scripts', '.i18n-report');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'source.json'), JSON.stringify(all, null, 1));
  fs.writeFileSync(path.join(reportDir, 'missing.json'), JSON.stringify(missing, null, 1));
  console.log('wrote scripts/.i18n-report/source.json and missing.json (translate the missing ones, then node scripts/i18n-merge.mjs <file>)');
}
