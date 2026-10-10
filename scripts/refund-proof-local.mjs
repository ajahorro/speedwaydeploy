/**
 * Local test of the proof-of-refund routes (needs the scratch Supabase stack and the backend running against it).
 *   node scripts/refund-proof-local.mjs --api http://127.0.0.1:55421 --anon <key> --service <key> --backend http://127.0.0.1:3999
 *
 * Uploads real pictures (rendered here) through POST /api/admin/refunds/proof, so the picture reading, the repeat checks,
 * the private storage and the database rule are all exercised. Everything it creates is removed at the end.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), SERVICE = arg('service'), BACKEND = arg('backend') || 'http://127.0.0.1:3999';
const DB = arg('db') || 'supabase_db_speedway-ledger-test';
if (!API || !ANON || !SERVICE) { console.error('Missing --api / --anon / --service'); process.exit(2); }
if (!/127\.0\.0\.1|localhost/.test(API)) { console.error('Refusing to run against a non-local database.'); process.exit(2); }

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'package.json'));
const sharp = require('sharp');

const sql = (statement) => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-tAc', statement], { encoding: 'utf8' }).trim();
const tag = Date.now().toString(36).toUpperCase();
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { (ok ? passed++ : failed++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const rest = (p, { token = SERVICE, method = 'GET', body, headers = {} } = {}) =>
  fetch(`${API}/rest/v1/${p}`, { method, headers: { apikey: token === SERVICE ? SERVICE : ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers }, body: body ? JSON.stringify(body) : undefined });

const makeUser = async (email, role) => {
  const created = await fetch(`${API}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Test-Pass-12345', email_confirm: true, user_metadata: { role, first_name: 'RP', last_name: role } }) });
  const user = await created.json();
  if (!user.id) throw new Error(`could not create ${email}: ${JSON.stringify(user)}`);
  sql(`insert into public.profiles (id, email, first_name, last_name, full_name, role, is_active) values ('${user.id}', '${email}', 'RP', '${role}', 'RP ${role}', '${role}', true) on conflict (id) do update set role = excluded.role, is_active = true`);
  const login = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Test-Pass-12345' }) });
  const session = await login.json();
  if (!session.access_token) throw new Error(`could not sign in ${email}: ${JSON.stringify(session)}`);
  return { id: user.id, token: session.access_token };
};

// A picture that reads like a transfer confirmation (or like nothing at all when no reference is given).
const picture = async (lines) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520"><rect width="100%" height="100%" fill="white"/>${lines.map((line, i) => `<text x="40" y="${90 + i * 80}" font-family="Arial" font-size="44" fill="black">${line}</text>`).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
};
const upload = async (token, { bookingId, refundReference, refundMethod, image }) => {
  const form = new FormData();
  form.append('bookingId', bookingId); form.append('refundReference', refundReference); form.append('refundMethod', refundMethod);
  form.append('proof', new Blob([image], { type: 'image/png' }), 'proof.png');
  const response = await fetch(`${BACKEND}/api/admin/refunds/proof`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

let admin, customer, bookingA, bookingB;
try {
  admin = await makeUser(`rp-admin-${tag}@test.local`, 'ADMIN');
  customer = await makeUser(`rp-cust-${tag}@test.local`, 'CUSTOMER');
  const newBooking = async (label) => {
    const r = await rest('bookings', { method: 'POST', body: { customer_id: customer.id, customer_name: 'RP Test', status: 'cancelled', payment_status: 'paid', total_amount: 1000, start_datetime: new Date(Date.now() + 5 * 864e5).toISOString(), end_datetime: new Date(Date.now() + 5 * 864e5 + 36e5).toISOString() } });
    const parsed = await r.json();
    const row = parsed[0];
    if (!row?.id) throw new Error(`booking ${label} not created: ${JSON.stringify(parsed)}`);
    await rest('payments', { method: 'POST', body: { booking_id: row.id, amount: 1000, method: 'GCash', payment_type: 'Full', status: 'PAID', reference_number: `RPPAY${tag}${label}` } });
    return row.id;
  };
  bookingA = await newBooking('A');
  bookingB = await newBooking('B');

  const reference = `${Math.floor(1e5 + Math.random() * 9e5)} ${Math.floor(1e5 + Math.random() * 9e5)} ${Math.floor(1e5 + Math.random() * 9e5)}`;
  const good = await picture(['GCash Transfer', 'Amount Sent PHP 1,000.00', `Ref No. ${reference}`, 'Status: Successful']);
  const noRef = await picture(['Thank you', 'Comar Garage']);

  // 1 not an administrator
  const asCustomer = await upload(customer.token, { bookingId: bookingA, refundReference: `RFD-T${tag}-1`, refundMethod: 'BANK TRANSFER', image: good });
  check('a customer cannot upload a proof', asCustomer.status === 403, `status ${asCustomer.status}`);

  // 2 a bank transfer proof without a reference number is refused
  const none = await upload(admin.token, { bookingId: bookingA, refundReference: `RFD-T${tag}-1`, refundMethod: 'BANK TRANSFER', image: noRef });
  check('a bank transfer proof with no reference number is refused', none.status === 422 && none.body.code === 'REFERENCE_NOT_DETECTED', `${none.status} ${none.body.code}`);
  check('nothing was stored for it', sql(`select count(*) from public.refund_proofs where booking_id='${bookingA}'`) === '0');

  // 3 the refund is still refused without a proof
  const refundToken = admin.token;
  const noProofRefund = await fetch(`${API}/rest/v1/rpc/process_booking_refund_v2`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${refundToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_booking_id: bookingA, p_refund_amount: 1000, p_refund_reason: 'Customer Request', p_refund_reference: `RFD-T${tag}-1`, p_refund_deduction: 0, p_refund_method: 'BANK TRANSFER', p_actor_id: admin.id }) });
  check('the refund is refused while there is no proof', !noProofRefund.ok && /REFUND_PROOF_REQUIRED/.test(await noProofRefund.text()));

  // 4 a proof with a reference is accepted
  const ok = await upload(admin.token, { bookingId: bookingA, refundReference: `RFD-T${tag}-1`, refundMethod: 'BANK TRANSFER', image: good });
  check('a proof showing a reference number is accepted', ok.status === 201 && ok.body.proof?.hasReference === true, `${ok.status} ${JSON.stringify(ok.body)}`);
  const stored = sql(`select proof_reference || '|' || storage_path from public.refund_proofs where booking_id='${bookingA}'`);
  check('the reference is stored without spaces', stored.startsWith(reference.replace(/\s+/g, '') + '|'), stored);

  // 5 the same picture or reference cannot back another refund
  const sameImage = await upload(admin.token, { bookingId: bookingB, refundReference: `RFD-T${tag}-2`, refundMethod: 'BANK TRANSFER', image: good });
  check('the same picture cannot be used again', sameImage.status === 409, `${sameImage.status} ${sameImage.body.code}`);
  const sameRefImage = await picture(['Different layout', `Ref No. ${reference}`, 'Sent via bank']);
  const sameRef = await upload(admin.token, { bookingId: bookingB, refundReference: `RFD-T${tag}-2`, refundMethod: 'BANK TRANSFER', image: sameRefImage });
  check('the same reference number cannot be used again', sameRef.status === 409 && sameRef.body.code === 'REFERENCE_REUSED', `${sameRef.status} ${sameRef.body.code}`);

  // 6 the refund now goes through under the same reference
  const refund = await fetch(`${API}/rest/v1/rpc/process_booking_refund_v2`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${refundToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_booking_id: bookingA, p_refund_amount: 1000, p_refund_reason: 'Customer Request', p_refund_reference: `RFD-T${tag}-1`, p_refund_deduction: 0, p_refund_method: 'BANK TRANSFER', p_actor_id: admin.id }) });
  check('the refund is recorded once its proof is on file', refund.ok, refund.ok ? '' : await refund.text());

  // 7 a recorded refund keeps its proof
  const afterRecorded = await upload(admin.token, { bookingId: bookingA, refundReference: `RFD-T${tag}-1`, refundMethod: 'BANK TRANSFER', image: await picture(['x', 'Ref No. 999 888 777 666']) });
  check('a recorded refund cannot get another proof', afterRecorded.status === 409 && afterRecorded.body.code === 'ALREADY_PROCESSED', `${afterRecorded.status} ${afterRecorded.body.code}`);

  // 8 the customer can open their proof, another person cannot
  const path_ = sql(`select storage_path from public.refund_proofs where booking_id='${bookingA}'`);
  const sign = (token) => fetch(`${API}/storage/v1/object/sign/refund-proofs/${path_}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 60 }) });
  const mine = await sign(customer.token);
  check('the customer of the booking can open the proof', mine.ok, `status ${mine.status}`);
  const other = await makeUser(`rp-other-${tag}@test.local`, 'CUSTOMER');
  const theirs = await sign(other.token);
  check('another customer cannot open it', !theirs.ok, `status ${theirs.status}`);
  const anon = await fetch(`${API}/storage/v1/object/public/refund-proofs/${path_}`);
  check('the private bucket serves nothing publicly', !anon.ok, `status ${anon.status}`);

  // 9 cash needs the picture only; a discard removes an unused proof (file and record)
  const cash = await upload(admin.token, { bookingId: bookingB, refundReference: `RFD-T${tag}-3`, refundMethod: 'CASH', image: noRef });
  check('a cash proof is accepted without a reference number', cash.status === 201 && cash.body.proof?.hasReference === false, `${cash.status} ${JSON.stringify(cash.body)}`);
  const discard = await fetch(`${BACKEND}/api/admin/refunds/proof/discard`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: bookingB, refundReference: `RFD-T${tag}-3` }) });
  const discarded = await discard.json();
  check('an unused proof can be discarded', discard.ok && discarded.removed === 1 && sql(`select count(*) from public.refund_proofs where booking_id='${bookingB}'`) === '0', JSON.stringify(discarded));
  const gone = sql(`select count(*) from storage.objects where bucket_id='refund-proofs' and name like '${bookingB}/%'`);
  check('and its file is removed from storage', gone === '0', `${gone} files left`);
  const discardRecorded = await fetch(`${BACKEND}/api/admin/refunds/proof/discard`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: bookingA, refundReference: `RFD-T${tag}-1` }) });
  check('a recorded refund\'s proof cannot be discarded', discardRecorded.status === 409, `status ${discardRecorded.status}`);

  // 10 clean-up of proofs whose refund never happened
  const stale = await upload(admin.token, { bookingId: bookingB, refundReference: `RFD-T${tag}-4`, refundMethod: 'CASH', image: await picture(['stale proof']) });
  sql(`update public.refund_proofs set created_at = now() - interval '2 days' where booking_id='${bookingB}'`);
  const refundProofs = require('./services/refundProofs.js');
  const { createClient } = require('@supabase/supabase-js');
  const service = createClient(API, SERVICE, { auth: { persistSession: false } });
  const purged = await refundProofs.purgeOrphanRefundProofs(service);
  check('a proof whose refund never happened is cleared after a day (record and file)', stale.status === 201 && purged.records >= 1 && sql(`select count(*) from public.refund_proofs where booking_id='${bookingB}'`) === '0' && sql(`select count(*) from storage.objects where bucket_id='refund-proofs' and name like '${bookingB}/%'`) === '0');
  check('while a proof that backs a refund stays', sql(`select count(*) from public.refund_proofs where booking_id='${bookingA}'`) === '1');
} catch (error) {
  failed++; console.log(`FAIL  test aborted: ${error.message}`);
} finally {
  for (const id of [bookingA, bookingB].filter(Boolean)) {
    try {
      const files = sql(`select name from storage.objects where bucket_id='refund-proofs' and name like '${id}/%'`).split(/\r?\n/).filter(Boolean);
      if (files.length) await fetch(`${API}/storage/v1/object/refund-proofs`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: files }) });
    } catch { /* ignore */ }
    try { sql(`set session_replication_role = replica; delete from public.payments where booking_id='${id}'; delete from public.audit_logs where booking_id='${id}'; delete from public.notifications where booking_id='${id}'; delete from public.refund_proofs where booking_id='${id}'; delete from public.bookings where id='${id}';`); } catch (e) { console.log('cleanup:', e.message.split('\n')[0]); }
  }
  for (const email of [`rp-admin-${tag}@test.local`, `rp-cust-${tag}@test.local`, `rp-other-${tag}@test.local`]) {
    try { sql(`set session_replication_role = replica; delete from public.profiles where email='${email}'; delete from auth.users where email='${email}';`); } catch { /* ignore */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
