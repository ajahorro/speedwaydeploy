/**
 * Photo and file storage test for the LOCAL scratch stack only (never production).
 *
 *   node scripts/storage-photo-local.mjs --api http://127.0.0.1:55421 --anon <key> --service <key>
 *
 * Needs the local stack to be running WITH the storage service, the buckets and access rules set up once with
 * scripts/sql/local-storage-setup.sql, and the test accounts
 * (cust@test.local, soa-customer@test.local, real-staff@test.local, staff@test.local, admin@test.local).
 * It re-creates four tagged bookings (scripts/sql/seed-photo-tests.sql) and checks, with real sign-ins:
 *   A  the buckets exist and are set up the way the app expects
 *   B  who may upload service photos, and what is refused (other technician, customer, unpaid booking,
 *      wrong phase, wrong file type, too big, not signed in)
 *   C  the "no before photo until the scheduled time, unless an early start was allowed" rule with real files
 *   D  who may view a photo (owner, assigned technician, administrator) and who may not
 *   E  the after photo, and that a second photo for the same phase is refused
 *   F  payment receipts and chat attachments
 * Everything it stores is removed again at the end, including the four test bookings unless --keep is given.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), SERVICE = arg('service');
const DB = arg('db') || 'supabase_db_speedway-ledger-test';
const KEEP = process.argv.includes('--keep'); // keep the four test bookings afterwards (for trying the screens by hand)
if (!API || !ANON || !SERVICE) { console.error('Missing --api / --anon / --service'); process.exit(2); }
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(API).hostname)) { console.error('Refusing non-local host'); process.exit(2); }

const PASSWORD = 'LocalTest-123';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };
const section = (text) => console.log(`\n=== ${text}`);

// tiny valid images
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

const login = async (email) => {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return { token: j.access_token, id: j.user.id, email };
};
const text = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const msg = (r) => String(r.body?.message || r.body?.error || (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))).slice(0, 90);

const upload = async (bucket, objectPath, bytes, { token, type = 'image/png' } = {}) => {
  const r = await fetch(`${API}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: { apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': type, 'x-upsert': 'false', 'cache-control': '3600' },
    body: bytes
  });
  return { ok: r.ok, status: r.status, body: await text(r) };
};
const sign = async (bucket, objectPath, token) => {
  const r = await fetch(`${API}/storage/v1/object/sign/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: { apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 900 })
  });
  const body = await text(r);
  if (!r.ok || !body.signedURL) return { ok: false, status: r.status, body };
  const file = await fetch(`${API}/storage/v1${body.signedURL}`);
  return { ok: file.ok, status: file.status, bytes: Buffer.from(await file.arrayBuffer()), body };
};
const rest = (p, { token = SERVICE, method = 'GET', body, headers = {} } = {}) =>
  fetch(`${API}/rest/v1/${p}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const restResult = async (r) => ({ ok: r.ok, status: r.status, body: await text(r) });
const remove = (bucket, paths) => fetch(`${API}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: { apikey: ANON, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) });
const listFolder = async (bucket, prefix) => {
  const r = await fetch(`${API}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000 }) });
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
};
// every file below a prefix (the list call shows one folder level at a time; a folder has no id)
const filesUnder = async (bucket, prefix) => {
  const out = [];
  for (const row of await listFolder(bucket, prefix)) {
    const full = `${prefix}/${row.name}`;
    if (row.id) out.push(full); else out.push(...await filesUnder(bucket, full));
  }
  return out;
};
const removeAs = (token, bucket, paths) => fetch(`${API}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) });
const sql = (statement) => execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-tAq', '-c', statement], { encoding: 'utf8' }).trim();

const stillStored = (bucket, p) => Number(sql(`select count(*) from storage.objects where bucket_id = '${bucket}' and name = '${p}'`)) === 1;
const B1 = 'a0000000-0000-0000-0000-000000000001', V1 = 'a0000001-0000-0000-0000-000000000001';
const B2 = 'a0000000-0000-0000-0000-000000000002', V2 = 'a0000001-0000-0000-0000-000000000002';
const B3 = 'a0000000-0000-0000-0000-000000000003', V3 = 'a0000001-0000-0000-0000-000000000003';
const B4 = 'a0000000-0000-0000-0000-000000000004', V4 = 'a0000001-0000-0000-0000-000000000004';
const objPath = (b, v, phase, name) => `${b}/${v}/${phase}/${name}`;
const stored = [];
const keep = (bucket, p) => stored.push([bucket, p]);

// ── setup ───────────────────────────────────────────────────────────────────────────────────────────────────
execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'], { input: fs.readFileSync(path.join(root, 'scripts', 'sql', 'seed-photo-tests.sql')), encoding: 'utf8', stdio: ['pipe', 'ignore', 'inherit'] });
for (const b of [B1, B2, B3, B4]) { const old = await filesUnder('service-proofs', b); if (old.length) await remove('service-proofs', old); }
const [tech, other, cust, cust2, admin] = await Promise.all(['real-staff@test.local', 'staff@test.local', 'cust@test.local', 'soa-customer@test.local', 'admin@test.local'].map(login));
console.log('signed in: technician, other technician, two customers, administrator');

// ── A. the storage service and its buckets ───────────────────────────────────────────────────────────────────
section('A. storage service and buckets');
{
  const status = await fetch(`${API}/storage/v1/status`, { headers: { apikey: ANON } });
  check('the storage service answers', status.ok, `HTTP ${status.status}`);
  const list = await (await fetch(`${API}/storage/v1/bucket`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();
  const byId = Object.fromEntries((Array.isArray(list) ? list : []).map((b) => [b.id, b]));
  const sp = byId['service-proofs'];
  check('service-proofs is private, 10 MB, images only', Boolean(sp) && sp.public === false && Number(sp.file_size_limit) === 10485760 && ['image/jpeg', 'image/png', 'image/webp', 'image/heic'].every((t) => (sp.allowed_mime_types || []).includes(t)), JSON.stringify({ public: sp?.public, limit: sp?.file_size_limit }));
  check('payment-receipts is public', byId['payment-receipts']?.public === true);
  check('chat_media is public with the 5 MB limit', byId.chat_media?.public === true && Number(byId.chat_media?.file_size_limit) === 5242880);
}

// ── B. who may upload service photos ─────────────────────────────────────────────────────────────────────────
section('B. who may upload service photos');
const p1Before = objPath(B1, V1, 'before', 'one.png');
{
  const r = await upload('service-proofs', p1Before, PNG, { token: tech.token });
  check('the assigned technician can upload a before photo (paid booking, vehicle not started)', r.ok, `HTTP ${r.status} ${r.ok ? '' : msg(r)}`);
  if (r.ok) keep('service-proofs', p1Before);

  // a file is only removed by an administrator (or the retention routine): a technician cannot undo an upload
  // a file that no photo record uses yet: only the person who stored it (or an administrator) can clear it
  const undo = objPath(B1, V1, 'before', 'undo.png');
  const undoUp = await upload('service-proofs', undo, PNG, { token: tech.token });
  await removeAs(other.token, 'service-proofs', [undo]);
  await removeAs(cust.token, 'service-proofs', [undo]);
  check('another technician or a customer cannot delete a file they did not store', undoUp.ok && stillStored('service-proofs', undo), '');
  await removeAs(tech.token, 'service-proofs', [undo]);
  check('the technician can clear their own interrupted upload (no photo record uses it)', undoUp.ok && !stillStored('service-proofs', undo), '');
  const adminOwn = objPath(B1, V1, 'before', 'admin-removes.png');
  const adminUp = await upload('service-proofs', adminOwn, PNG, { token: tech.token });
  if (adminUp.ok) await removeAs(admin.token, 'service-proofs', [adminOwn]);
  check('an administrator can delete a stored photo', adminUp.ok && !stillStored('service-proofs', adminOwn), '');

  const o = await upload('service-proofs', objPath(B1, V1, 'before', 'other-tech.png'), PNG, { token: other.token });
  check('another technician cannot upload to that vehicle', !o.ok, `HTTP ${o.status} ${msg(o)}`);
  if (o.ok) keep('service-proofs', objPath(B1, V1, 'before', 'other-tech.png'));

  const c = await upload('service-proofs', objPath(B1, V1, 'before', 'customer.png'), PNG, { token: cust.token });
  check('a customer cannot upload service photos', !c.ok, `HTTP ${c.status} ${msg(c)}`);
  if (c.ok) keep('service-proofs', objPath(B1, V1, 'before', 'customer.png'));

  const n = await upload('service-proofs', objPath(B1, V1, 'before', 'anon.png'), PNG, {});
  check('nobody who is not signed in can upload', !n.ok, `HTTP ${n.status} ${msg(n)}`);
  if (n.ok) keep('service-proofs', objPath(B1, V1, 'before', 'anon.png'));

  const u = await upload('service-proofs', objPath(B4, V4, 'before', 'unpaid.png'), PNG, { token: tech.token });
  check('no upload while the booking has no verified downpayment', !u.ok, `HTTP ${u.status} ${msg(u)}`);
  if (u.ok) keep('service-proofs', objPath(B4, V4, 'before', 'unpaid.png'));

  const w = await upload('service-proofs', objPath(B3, V3, 'before', 'wrong-tech.png'), PNG, { token: tech.token });
  check('the technician cannot upload to a vehicle assigned to someone else', !w.ok, `HTTP ${w.status} ${msg(w)}`);
  if (w.ok) keep('service-proofs', objPath(B3, V3, 'before', 'wrong-tech.png'));

  const a = await upload('service-proofs', objPath(B1, V1, 'after', 'too-early.png'), PNG, { token: tech.token });
  check('no after photo before the service has started', !a.ok, `HTTP ${a.status} ${msg(a)}`);
  if (a.ok) keep('service-proofs', objPath(B1, V1, 'after', 'too-early.png'));

  const ph = await upload('service-proofs', objPath(B1, V1, 'during', 'x.png'), PNG, { token: tech.token });
  check('only the before and after phases exist', !ph.ok, `HTTP ${ph.status} ${msg(ph)}`);
  if (ph.ok) keep('service-proofs', objPath(B1, V1, 'during', 'x.png'));

  const t = await upload('service-proofs', objPath(B1, V1, 'before', 'notes.txt'), Buffer.from('not a photo'), { token: tech.token, type: 'text/plain' });
  check('a file that is not an image is refused', !t.ok, `HTTP ${t.status} ${msg(t)}`);
  if (t.ok) keep('service-proofs', objPath(B1, V1, 'before', 'notes.txt'));

  const big = await upload('service-proofs', objPath(B1, V1, 'before', 'huge.png'), Buffer.alloc(11 * 1024 * 1024, 1), { token: tech.token });
  check('a photo over 10 MB is refused', !big.ok, `HTTP ${big.status} ${msg(big)}`);
  if (big.ok) keep('service-proofs', objPath(B1, V1, 'before', 'huge.png'));
}

// ── C. before photo and the scheduled time ───────────────────────────────────────────────────────────────────
section('C. before photo, scheduled time and early start');
{
  const row = (b, v, p, phase = 'before') => ({ booking_id: b, booking_vehicle_id: v, phase, storage_path: p, uploaded_by: tech.id, source: 'upload' });
  const first = await restResult(await rest('service_photos', { token: tech.token, method: 'POST', body: [row(B1, V1, p1Before)] }));
  check('the technician records the before photo once the scheduled time has come', first.ok, `HTTP ${first.status} ${first.ok ? '' : msg(first)}`);

  await removeAs(tech.token, 'service-proofs', [p1Before]);
  check('once a photo is recorded the technician can no longer delete its file', stillStored('service-proofs', p1Before), '');

  const dupObj = await upload('service-proofs', objPath(B1, V1, 'before', 'two.png'), PNG, { token: tech.token });
  check('a second before photo is refused once one is recorded', !dupObj.ok, `HTTP ${dupObj.status} ${msg(dupObj)}`);
  if (dupObj.ok) keep('service-proofs', objPath(B1, V1, 'before', 'two.png'));
  const dupRow = await restResult(await rest('service_photos', { token: tech.token, method: 'POST', body: [row(B1, V1, p1Before)] }));
  check('and so is a second record for it', !dupRow.ok, `HTTP ${dupRow.status} ${msg(dupRow)}`);

  const custRow = await restResult(await rest('service_photos', { token: cust.token, method: 'POST', body: [row(B2, V2, objPath(B2, V2, 'before', 'c.png'))] }));
  check('a customer cannot record a service photo', !custRow.ok, `HTTP ${custRow.status} ${msg(custRow)}`);

  // booking 2 starts in three hours: the file may be stored, but it cannot be recorded until the time or an early start
  const p2Before = objPath(B2, V2, 'before', 'early.png');
  const up2 = await upload('service-proofs', p2Before, PNG, { token: tech.token });
  if (up2.ok) keep('service-proofs', p2Before);
  const early = await restResult(await rest('service_photos', { token: tech.token, method: 'POST', body: [row(B2, V2, p2Before)] }));
  check('before the scheduled time the photo cannot be recorded', !early.ok, `HTTP ${early.status} ${msg(early)}`);

  const allow = await restResult(await rest('rpc/allow_early_start', { token: tech.token, method: 'POST', body: { p_booking_id: B2 } }));
  check('the technician allows an early start (customer arrived early)', allow.ok, `HTTP ${allow.status} ${allow.ok ? '' : msg(allow)}`);
  const afterAllow = await restResult(await rest('service_photos', { token: tech.token, method: 'POST', body: [row(B2, V2, p2Before)] }));
  check('after the early start is allowed the same photo is accepted', afterAllow.ok, `HTTP ${afterAllow.status} ${afterAllow.ok ? '' : msg(afterAllow)}`);
}

// ── D. who may view a photo ──────────────────────────────────────────────────────────────────────────────────
section('D. who may view a photo');
{
  const same = (r) => r.ok && r.bytes?.length === PNG.length && r.bytes.equals(PNG);
  check('the customer of the booking can view it', same(await sign('service-proofs', p1Before, cust.token)));
  check('the assigned technician can view it', same(await sign('service-proofs', p1Before, tech.token)));
  check('an administrator can view it', same(await sign('service-proofs', p1Before, admin.token)));
  const o = await sign('service-proofs', p1Before, other.token);
  check('another technician cannot view it', !o.ok, `HTTP ${o.status}`);
  const c2 = await sign('service-proofs', p1Before, cust2.token);
  check('another customer cannot view it', !c2.ok, `HTTP ${c2.status}`);
  const anon = await sign('service-proofs', p1Before, null);
  check('someone who is not signed in cannot view it', !anon.ok, `HTTP ${anon.status}`);
  const direct = await fetch(`${API}/storage/v1/object/public/service-proofs/${p1Before}`);
  check('the private bucket has no public link', !direct.ok, `HTTP ${direct.status}`);
}

// ── E. after photo ───────────────────────────────────────────────────────────────────────────────────────────
section('E. the after photo');
{
  sql(`set session_replication_role = replica; update public.booking_vehicles set status = 'IN_PROGRESS' where id = '${V1}';`);
  const p1After = objPath(B1, V1, 'after', 'done.jpg');
  const up = await upload('service-proofs', p1After, JPG, { token: tech.token, type: 'image/jpeg' });
  check('once the service is under way the technician can upload the after photo', up.ok, `HTTP ${up.status} ${up.ok ? '' : msg(up)}`);
  if (up.ok) keep('service-proofs', p1After);
  const rec = await restResult(await rest('service_photos', { token: tech.token, method: 'POST', body: [{ booking_id: B1, booking_vehicle_id: V1, phase: 'after', storage_path: p1After, uploaded_by: tech.id, source: 'upload' }] }));
  check('and record it', rec.ok, `HTTP ${rec.status} ${rec.ok ? '' : msg(rec)}`);
  const again = await upload('service-proofs', objPath(B1, V1, 'after', 'again.jpg'), JPG, { token: tech.token, type: 'image/jpeg' });
  check('a second after photo is refused', !again.ok, `HTTP ${again.status} ${msg(again)}`);
  if (again.ok) keep('service-proofs', objPath(B1, V1, 'after', 'again.jpg'));
  const view = await sign('service-proofs', p1After, cust.token);
  check('the customer can view the after photo', view.ok && view.bytes.equals(JPG));
  const counted = await (await rest(`service_photos?booking_vehicle_id=eq.${V1}&select=phase`, { token: cust.token })).json();
  check('the customer sees both photo records of the vehicle', Array.isArray(counted) && counted.length === 2, `${Array.isArray(counted) ? counted.length : 'error'} records`);
  const hidden = await (await rest(`service_photos?booking_vehicle_id=eq.${V1}&select=phase`, { token: cust2.token })).json();
  check('another customer sees none', Array.isArray(hidden) && hidden.length === 0, `${Array.isArray(hidden) ? hidden.length : 'error'} records`);
}

// ── F. payment receipts and chat attachments ─────────────────────────────────────────────────────────────────
section('F. payment receipts and chat attachments');
{
  const receipt = `${cust.id}/test-receipt-${Date.now()}.png`;
  const up = await upload('payment-receipts', receipt, PNG, { token: cust.token });
  check('a signed-in customer can upload a payment receipt', up.ok, `HTTP ${up.status} ${up.ok ? '' : msg(up)}`);
  if (up.ok) keep('payment-receipts', receipt);
  const pub = await fetch(`${API}/storage/v1/object/public/payment-receipts/${receipt}`);
  check('the receipt opens through its public link', pub.ok && Buffer.from(await pub.arrayBuffer()).equals(PNG), `HTTP ${pub.status}`);
  const anon = await upload('payment-receipts', `anon/${Date.now()}.png`, PNG, {});
  check('nobody who is not signed in can upload a receipt', !anon.ok, `HTTP ${anon.status} ${msg(anon)}`);

  const chat = `chat/${B1}/${Date.now()}.png`;
  const cu = await upload('chat_media', chat, PNG, { token: cust.token });
  check('a chat picture uploads', cu.ok, `HTTP ${cu.status} ${cu.ok ? '' : msg(cu)}`);
  if (cu.ok) keep('chat_media', chat);
  const cbig = await upload('chat_media', `chat/${B1}/big-${Date.now()}.png`, Buffer.alloc(6 * 1024 * 1024, 1), { token: cust.token });
  check('a chat file over 5 MB is refused', !cbig.ok, `HTTP ${cbig.status} ${msg(cbig)}`);
}

// ── clean up ─────────────────────────────────────────────────────────────────────────────────────────────────
section('cleaning up');
for (const bucket of ['service-proofs', 'payment-receipts', 'chat_media']) {
  const paths = stored.filter(([b]) => b === bucket).map(([, p]) => p);
  if (paths.length) await remove(bucket, paths);
}
sql(`set session_replication_role = replica; delete from public.service_photos where booking_id::text like 'a0000000-%'; update public.booking_vehicles set status = 'SCHEDULED' where id = '${V1}'; update public.bookings set early_start_allowed_at = null, early_start_allowed_by = null where id = '${B2}';`);
const leftovers = [];
for (const b of [B1, B2, B3, B4]) leftovers.push(...await filesUnder('service-proofs', b));
check('nothing the test stored is left behind', leftovers.length === 0, `${leftovers.length} left`);

if (!KEEP) {
  // the test bookings occupy bays around "now", which would disturb tests that depend on free capacity
  sql(`set session_replication_role = replica; delete from public.service_photos where booking_id::text like 'a0000000-%'; delete from public.payments where booking_id::text like 'a0000000-%'; delete from public.booking_messages where booking_id::text like 'a0000000-%'; delete from public.booking_vehicles where booking_id::text like 'a0000000-%'; delete from public.bookings where id::text like 'a0000000-%';`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} storage checks passed.`);
process.exit(failed ? 1 : 0);
