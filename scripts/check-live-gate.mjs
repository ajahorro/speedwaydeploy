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

const { data, error } = await db.rpc('debug_function_source', { p_name: 'create_booking_atomic' });
if (error) throw new Error(`Could not read create_booking_atomic(): ${error.message}`);
if (typeof data !== 'string' || !data) throw new Error('create_booking_atomic() source was empty.');

const source = data.toLowerCase();
const checks = [
  ['current OCR gate is installed', source.includes('ocr_verdict_gate_v3')],
  ['payment verdict is allow-listed', /v_verdict\s+not\s+in\s*\(\s*'for_verification'\s*,\s*'rejected'/.test(source)],
  ['rejected receipts cannot create bookings', /if\s+v_verdict\s*=\s*'rejected'/.test(source)],
  ['customers cannot self-settle bookings', /v_verdict\s+in\s*\(\s*'paid'\s*,\s*'refund_pending'\s*,\s*'refunded'\)\s+and\s+not\s+public\.is_admin\(\)/.test(source)],
  ['booking payment status is derived from the verdict', /v_payment_status\s*:=\s*v_derived::booking_payment_status/.test(source)],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
}

if (failed > 0) process.exitCode = 1;