import fs from 'node:fs';

const fn = fs.readFileSync('supabase/functions/booking-lifecycle/index.ts', 'utf8');
const d = fs.readFileSync('supabase/functions/_shared/deno-types.d.ts', 'utf8');

const checks = [
  ['index.ts references the new typings file', fn.includes('_shared/deno-types.d.ts')],
  ['index.ts no longer references the old file', !fn.includes('deno-globals.d.ts')],
  ['typings use an interface (avoids global namespace merge)', /interface DenoGlobal/.test(d)],
  ['typings declare Deno as a const', /declare const Deno: DenoGlobal/.test(d)],
  ['no bare `function delete(` (the reserved-word syntax error)', !/function delete\(/.test(d)],
  ['no `declare namespace Deno` (would merge into a lib-provided Deno)', !/^\s*declare namespace Deno/m.test(d)],
  ['btoa is declared for the receipt-PDF path', /declare function btoa/.test(d)],
  ['old broken file is gone', !fs.existsSync('supabase/functions/_shared/deno-globals.d.ts')],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);