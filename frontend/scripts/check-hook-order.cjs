// Guard against the exact regression that crashed production:
// a memoized value declared AFTER the useEffect that references/lists it.
//
// This is the SAME detector that found the 6 sites, kept in the repo as a
// permanent check (run in CI / pre-commit) so the ordering mistake cannot
// silently return.
const fs = require('fs');
const path = require('path');

const root = path.join(process.cwd(), 'src');
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.jsx?$/.test(e.name)) files.push(p);
  }
};
walk(root);

const hits = [];

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  const decls = [];
  lines.forEach((l, i) => {
    const m = l.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?use(?:Callback|Memo)\s*\(/);
    if (m) decls.push({ name: m[1], line: i + 1 });
  });

  for (const d of decls) {
    const nameRe = new RegExp(`\\b${d.name.replace(/\$/g, '\\$')}\\b`);
    for (let j = d.line - 2; j >= 0; j--) {
      const prev = lines[j];
      if (!/^\s*\}[,)]?\s*(?:,\s*)?\[[^\]]*\]\s*\)\s*;?\s*$/.test(prev)) continue;
      if (!nameRe.test(prev)) continue;
      hits.push({ file: path.relative(process.cwd(), file), name: d.name, declLine: d.line, depLine: j + 1 });
      break;
    }
  }
}

if (!hits.length) {
  console.log('OK: no memoized value is referenced before its declaration.');
  process.exit(0);
}
console.log(`TDZ RISK (${hits.length}) — a memoized value is used before it is declared:\n`);
hits.forEach((h) => console.log(`  ${h.file}\n    '${h.name}' declared line ${h.declLine}, dep array line ${h.depLine}\n`));
process.exit(1);