// Audits the frontend for broken relative imports and backend endpoints that
// were referenced before but no longer exist.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../frontend/src');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) files.push(p);
  }
})(root);

const missing = [];
let total = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    total += 1;
    const base = path.resolve(path.dirname(file), m[1]);
    const candidates = [base, base + '.jsx', base + '.js', base + '.ts', base + '.tsx',
      path.join(base, 'index.jsx'), path.join(base, 'index.js')];
    if (!candidates.some(c => fs.existsSync(c))) {
      missing.push(path.relative(root, file) + '  ->  ' + m[1]);
    }
  }
}
console.log('frontend files:', files.length);
console.log('relative imports scanned:', total);
console.log('BROKEN imports:', missing.length);
missing.forEach(x => console.log('  ' + x));

// --- Compare API routes against what the frontend actually calls -------------
const server = fs.readFileSync(path.resolve(__dirname, '../backend/server.js'), 'utf8');
const defined = new Set();
const routeRe = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
let r;
while ((r = routeRe.exec(server))) defined.add(r[2]);

const called = new Set();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const callRe = /`\$\{BACKEND_URL\}([^`?]*)`|'https?:\/\/localhost:3000([^']*)'/g;
  let c;
  while ((c = callRe.exec(src))) {
    const route = (c[1] || c[2] || '').trim();
    if (route.startsWith('/api/') || route.startsWith('/admin/')) called.add(route);
  }
}
console.log('\nbackend routes defined:', defined.size);
console.log('distinct backend routes called from frontend:', called.size);
const orphanCalls = [...called].filter(route => {
  if (defined.has(route)) return false;
  // Allow :param placeholders to match a defined :param route
  return ![...defined].some(d => d.split('/').length === route.split('/').length);
});
console.log('frontend calls with NO matching backend route:', orphanCalls.length);
orphanCalls.forEach(x => console.log('  ' + x));
