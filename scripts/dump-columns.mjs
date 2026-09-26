/**
 * Lists the live columns of the tables the OCR verdict touches, so the guard is
 * written against the REAL schema. Guessing a column name is what produced the
 * 42703 this script exists to prevent.
 */
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

const dump = async (table, wanted) => {
  const { data, error } = await db.from(table).select('*').limit(1);
  if (error) {
    console.log(`${table}: ERROR ${error.code} ${error.message}`);
    return;
  }
  const cols = data && data.length ? Object.keys(data[0]) : [];
  if (!cols.length) {
    // No rows — probe the specific columns instead.
    const found = [];
    for (const c of wanted) {
      const { error: e } = await db.from(table).select(c).limit(1);
      if (!e) found.push(c);
    }
    console.log(`${table} (no rows; probed): ${found.join(', ') || '(none of the probed columns exist)'}`);
    return;
  }
  console.log(`${table}:`);
  console.log('  ' + cols.join(', '));
};

await dump('payments', ['ocr_metadata', 'detected_amount', 'detected_ref', 'transfer_fee', 'credit_applied', 'status', 'method', 'reference_number']);
console.log('');
await dump('bookings', ['ocr_metadata', 'payment_status', 'total_amount', 'status']);