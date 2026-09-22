/**
 * Confirm the Task B schema objects are live on the hosted DB after deployment.
 */
import fs from 'node:fs';
const envTxt = fs.readFileSync(new URL('../frontend/.env', import.meta.url), 'utf8');
const pick = (k) => envTxt.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const SB = pick('VITE_SUPABASE_URL');
const ANON = pick('VITE_SUPABASE_ANON_KEY');

const login = async (e, p) => (await (await fetch(`${SB}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: p }),
})).json()).access_token;

const rest = async (tok, path) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${tok}` } });
  return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : await r.text() };
};
const rpc = async (tok, fn, args) => {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

let pass = 0, fail = 0;
const results = [];
const check = async (name, fn) => { try { const n = await fn(); pass++; results.push(`PASS  ${name}${n ? '  (' + n + ')' : ''}`); } catch (e) { fail++; results.push(`FAIL  ${name}\n        ${e.message}`); } };

const admin = await login('testadmin961@gmail.com', 'admin1234');
const customer = await login('jayneahorro@gmail.com', 'jayne1234');

await check('business_config: 4 QR recipient fields + version', async () => {
  const r = await rest(admin, 'business_config?select=qr_account_name,qr_account_number,fallback_receiver_name,fallback_receiver_number,qr_config_version,qr_config_complete&limit=1');
  if (!r.ok) throw new Error(JSON.stringify(r.body));
  const row = r.body[0] || {};
  for (const k of ['qr_account_name','qr_account_number','fallback_receiver_name','fallback_receiver_number','qr_config_version','qr_config_complete']) {
    if (!(k in row)) throw new Error(`missing ${k}`);
  }
  return `v${row.qr_config_version}`;
});

await check('bookings: active_qr_snapshot column present', async () => {
  const r = await rest(admin, 'bookings?select=active_qr_snapshot,qr_snapshot_version&limit=1');
  if (!r.ok) throw new Error(JSON.stringify(r.body));
  return 'ok';
});

await check('payments: transfer_fee + net_credit columns present', async () => {
  const r = await rest(admin, 'payments?select=transfer_fee,net_credit&limit=1');
  if (!r.ok) throw new Error(JSON.stringify(r.body));
  return 'ok';
});

await check('customer_credit_ledger table present', async () => {
  const r = await rest(admin, 'customer_credit_ledger?select=id,entry_type,amount,balance_after&limit=1');
  if (!r.ok) throw new Error(JSON.stringify(r.body));
  return `${r.body.length} row(s)`;
});

await check('qr_change_otp table present', async () => {
  const r = await rest(admin, 'qr_change_otp?select=id,consumed,expires_at&limit=1');
  if (!r.ok) throw new Error(JSON.stringify(r.body));
  return `${r.body.length} row(s)`;
});

await check('customer_excess_credit() RPC callable', async () => {
  const r = await rpc(admin, 'customer_excess_credit', { p_customer_id: '00000000-0000-0000-0000-000000000000' });
  if (r.status === 404) throw new Error('RPC missing (404)');
  return `status=${r.status} -> ${JSON.stringify(r.body)}`;
});

await check('apply_service_downpayment() RPC exists', async () => {
  const r = await rpc(admin, 'apply_service_downpayment', { p_customer_id: '00000000-0000-0000-0000-000000000000', p_booking_id: '00000000-0000-0000-0000-000000000000', p_downpayment: 100 });
  if (r.status === 404) throw new Error('RPC missing (404)');
  return `status=${r.status}`;
});

await check('settle_overpayment_on_completion() RPC exists', async () => {
  const r = await rpc(admin, 'settle_overpayment_on_completion', { p_booking_id: '00000000-0000-0000-0000-000000000000' });
  if (r.status === 404) throw new Error('RPC missing (404)');
  return `status=${r.status}`;
});

await check('start_qr_change_otp() RPC exists', async () => {
  const r = await rpc(admin, 'start_qr_change_otp', { p_payload: {}, p_otp_hash: 'aaaaaaaaaaaaaaaa' });
  if (r.status === 404) throw new Error('RPC missing (404)');
  return `status=${r.status}`;
});

await check('verify_qr_change_otp() RPC exists', async () => {
  const r = await rpc(admin, 'verify_qr_change_otp', { p_otp_hash: 'aaaaaaaaaaaaaaaa' });
  if (r.status === 404) throw new Error('RPC missing (404)');
  return `status=${r.status}`;
});

console.log('\n═══ Task B — Hosted Schema Verification ═══\n');
console.log(results.join('\n'));
console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);