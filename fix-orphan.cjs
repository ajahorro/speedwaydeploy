// Remove the orphaned body of the old undo-no-show handler: lines 4150-4311
// (1-based, inclusive) in backend/server.js. The replacement handler now ends at
// its own `}));` on line 4149.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'backend', 'server.js');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

// 0-based indices
const start = 4149; // -> line 4150, first line of the orphan
const end = 4311;   // exclusive -> removes through line 4310 (blank line before the next route)

const before = lines[start - 1];
const first = lines[start];
const last = lines[end - 1];
const after = lines[end];

console.log('line before removal :', JSON.stringify(before));
console.log('first line removed  :', JSON.stringify(first));
console.log('last line removed   :', JSON.stringify(last));
console.log('line after removal  :', JSON.stringify(after));

if (!/^\}\);$/.test(before)) throw new Error('Unexpected anchor BEFORE block');
if (!/maybeSingle\(\)/.test(first)) throw new Error('Unexpected START of block');
if (!/^\}\);$/.test(last)) throw new Error('Unexpected END of block');
if (!/^app\.post\('\/api\/bookings\/add-service'/.test(after)) throw new Error('Unexpected anchor AFTER block');

const out = [...lines.slice(0, start), ...lines.slice(end)];
fs.writeFileSync(file, out.join('\n'));
console.log(`\nRemoved ${end - start} lines. File now ${out.length} lines.`);