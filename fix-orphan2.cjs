// Removes the orphaned body of the OLD undo-no-show handler that is now dead
// code below the new RPC-based handler in backend/server.js.
//
// Content-anchored rather than line-number-anchored: it locates the stale block
// by its own text and by the route that must follow it, so it cannot delete the
// wrong range even if the file shifts.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'backend', 'server.js');
const raw = fs.readFileSync(file, 'utf8');

// This file uses CRLF line endings. Splitting on '\n' alone would leave a
// trailing '\r' on every line, which silently defeats every exact-match anchor
// below (the first attempt failed exactly this way: the START line was present
// and correct, yet `startsWith` never matched). Normalise on read and restore
// CRLF on write so the diff stays line-ending-clean.
const usesCrlf = raw.includes('\r\n');
const lines = raw.split(/\r?\n/);

// START: the stale `.maybeSingle()` comment that opened the old handler body.
const startIdx = lines.findIndex((l) => l.startsWith('    // `.maybeSingle()` rather than `.single()`.'));
if (startIdx < 0) throw new Error('orphan START not found');

// END: the closing `});` of the stale handler, identified by the route that
// follows it two lines later.
let endIdx = -1;
for (let i = startIdx; i < lines.length; i += 1) {
  if (lines[i] === '});' && /^app\.post\('\/api\/bookings\/add-service'/.test(lines[i + 2] || '')) {
    endIdx = i;
    break;
  }
}
if (endIdx < 0) throw new Error('orphan END not found');

console.log('line before :', JSON.stringify(lines[startIdx - 1]));
console.log('first removed:', JSON.stringify(lines[startIdx]).slice(0, 72));
console.log('last removed :', JSON.stringify(lines[endIdx]));
console.log('line after  :', JSON.stringify(lines[endIdx + 2]));

const out = [...lines.slice(0, startIdx), '', ...lines.slice(endIdx + 1)];
fs.writeFileSync(file, out.join(usesCrlf ? '\r\n' : '\n'));
console.log(`\nRemoved ${endIdx - startIdx + 1} lines. File now ${out.length} lines.`);