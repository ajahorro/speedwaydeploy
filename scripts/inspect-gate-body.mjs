import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const f of ['backend/.env']) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data } = await db.rpc('debug_function_source', { p_name: 'create_booking_atomic' });
const lines = data.split('\n');

const i = lines.findIndex((l) => /OCR_VERDICT_GATE_V2/.test(l));
console.log('=== live gate body (line ' + (i + 1) + ') ===');
lines.slice(i, i + 46).forEach((l, k) => console.log(`${i + k + 1}: ${l}`));

console.log('\n=== does the master INSERT use v_payment_status? ===');
lines.forEach((l, k) => {
  if (/v_payment_status/.test(l)) console.log(`${k + 1}: ${l.trim()}`);
});