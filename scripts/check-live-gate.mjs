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
console.log('OCR_VERDICT_GATE present :', data.includes('OCR_VERDICT_GATE'));
console.log("reads client payload    :", data.includes("v_payment -> 'ocr_metadata'"));
console.log('reads from payments     :', data.includes('from public.payments pay'));