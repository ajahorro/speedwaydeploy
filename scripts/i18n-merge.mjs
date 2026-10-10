/**
 * Merges translated batch files (JSON objects of "English": "Filipino") into frontend/src/i18n/tl.json.
 *   node scripts/i18n-merge.mjs <batch.json> [more.json ...]
 * Every entry must keep the same number of {} placeholders as its English text; mismatches are refused.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const target = path.join(root, 'frontend', 'src', 'i18n', 'tl.json');
let catalog = {};
try { catalog = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { /* new catalog */ }

const count = (text) => (text.match(/\{\}/g) || []).length;
let added = 0;
const refused = [];
for (const file of process.argv.slice(2)) {
  const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [source, text] of Object.entries(batch)) {
    if (typeof text !== 'string' || !text.trim()) continue;
    if (count(source) !== count(text)) { refused.push(source); continue; }
    if (!(source in catalog)) added += 1;
    catalog[source] = text;
  }
}
const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(target, JSON.stringify(sorted, null, 1));
console.log(`${added} added, ${Object.keys(sorted).length} in the catalog.`);
if (refused.length) console.log(`${refused.length} refused (placeholder mismatch):\n - ${refused.join('\n - ')}`);
