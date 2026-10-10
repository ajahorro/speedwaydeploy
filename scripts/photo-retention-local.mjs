/**
 * Photo retention test with REAL stored files, for the LOCAL scratch stack only (never production).
 *
 *   node scripts/photo-retention-local.mjs --api http://127.0.0.1:55421 --anon <key> --service <key>
 *
 * Needs the local stack with the storage service (buckets set up once with scripts/sql/local-storage-setup.sql) and
 * migration 20261206000001. It stores real files in the private service-proofs bucket, ages their records, and runs
 * the backend routine (backend/services/photoRetention.js):
 *   - expired photos lose their file AND their record
 *   - a photo on legal hold, and a photo inside the window, keep both
 *   - a legacy record (a full web address) loses only its record; a file in another bucket is never touched
 *   - if removing a file fails, the record stays so the next run can try again
 *   - several batches in one run, and a second run finds nothing left
 * Everything it stores is removed again at the end.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null; };
const API = arg('api'), ANON = arg('anon'), SERVICE = arg('service');
const DB = arg('db') || 'supabase_db_speedway-ledger-test';
if (!API || !ANON || !SERVICE) { console.error('Missing --api / --anon / --service'); process.exit(2); }
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(API).hostname)) { console.error('Refusing non-local host'); process.exit(2); }

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const backendRequire = createRequire(path.join(root, 'backend', 'package.json'));
const { createClient } = backendRequire('@supabase/supabase-js');
const { purgeExpiredServicePhotos } = backendRequire('./services/photoRetention.js');
const supabase = createClient(API, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; };
const sql = (statement) => execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-tAq', '-c', statement], { encoding: 'utf8' }).trim();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const B = 'a0000000-0000-0000-0000-000000000001', V = 'a0000001-0000-0000-0000-000000000001';
const tag = Date.now().toString(36);
const objectPath = (name) => `${B}/${V}/before/retention-${tag}-${name}.png`;
const put = async (bucket, p) => {
  const r = await fetch(`${API}/storage/v1/object/${bucket}/${p}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: PNG });
  if (!r.ok) throw new Error(`could not store ${p}: ${r.status} ${await r.text()}`);
};
const fileExists = (bucket, p) => Number(sql(`select count(*) from storage.objects where bucket_id = '${bucket}' and name = '${p}'`)) === 1;
const recordExists = (id) => Number(sql(`select count(*) from public.service_photos where id = '${id}'`)) === 1;
let seq = 0;
const idTail = Date.now().toString(16).padStart(12, '0').slice(-12);
const newId = () => `9b00${String(++seq).padStart(4, '0')}-0000-0000-0000-${idTail}`;
const addRecord = ({ id, storagePath, monthsOld, archived = true, hold = false, phase = 'before' }) => sql(
  `set session_replication_role = replica; insert into public.service_photos (id, booking_id, booking_vehicle_id, phase, storage_path, source, uploaded_at, archived_at, retention_exempt) values ('${id}', '${B}', '${V}', '${phase}', '${storagePath}', 'upload', now() - interval '${monthsOld} months', ${archived ? "now() - interval '1 month'" : 'null'}, ${hold});`);

console.log('\n=== setup');
sql(`set session_replication_role = replica; delete from public.service_photos where booking_id = '${B}'; update public.business_config set photo_retention_purge_months = 24 where id = (select id from public.business_config order by id limit 1);`);

// four records that must go, one on hold, one inside the window
const expired = ['a', 'b', 'c', 'd'].map((n) => ({ id: newId(), path: objectPath(`expired-${n}`) }));
const hold = { id: newId(), path: objectPath('hold') };
const fresh = { id: newId(), path: objectPath('fresh') };
for (const e of expired) { await put('service-proofs', e.path); addRecord({ id: e.id, storagePath: e.path, monthsOld: 26 }); }
await put('service-proofs', hold.path); addRecord({ id: hold.id, storagePath: hold.path, monthsOld: 30, hold: true });
await put('service-proofs', fresh.path); addRecord({ id: fresh.id, storagePath: fresh.path, monthsOld: 3, archived: false });
// a legacy record with a full web address, and one that points at a file in ANOTHER bucket (must never be touched)
const otherBucketFile = `receipts/retention-${tag}-other-bucket.png`;
await put('payment-receipts', otherBucketFile);
const legacy = { id: newId(), path: 'https://old-host.example/photos/legacy.jpg' };
const crossBucket = { id: newId(), path: `${API}/storage/v1/object/public/payment-receipts/${otherBucketFile}` };
addRecord({ id: legacy.id, storagePath: legacy.path, monthsOld: 27 });
addRecord({ id: crossBucket.id, storagePath: crossBucket.path, monthsOld: 27 });
console.log('stored 6 real files and 8 records (4 expired, 1 legal hold, 1 fresh, 2 legacy)');

console.log('\n=== a failed file removal keeps the records');
{
  const failing = { rpc: supabase.rpc.bind(supabase), from: supabase.from.bind(supabase), storage: { from: () => ({ remove: async () => ({ data: null, error: new Error('storage is down') }) }) } };
  let thrown = null;
  try { await purgeExpiredServicePhotos(failing); } catch (error) { thrown = error; }
  check('the routine reports the failure', Boolean(thrown) && /storage is down/.test(thrown.message), thrown?.message);
  check('no record was deleted when its file could not be removed', expired.every((e) => recordExists(e.id)) && recordExists(legacy.id), '');
  check('and no file was lost', expired.every((e) => fileExists('service-proofs', e.path)), '');
}

console.log('\n=== the routine, in small batches');
const first = await purgeExpiredServicePhotos(supabase, { batchSize: 2 });
check('it handled every expired record over several batches', first.records === 6, `records ${first.records}, files ${first.files}`);
check('each expired photo lost its stored file', expired.every((e) => !fileExists('service-proofs', e.path)), '');
check('each expired photo lost its record', expired.every((e) => !recordExists(e.id)), '');
check('only real files are counted', first.files === 4, `${first.files} files`);
check('a photo on legal hold kept its file and its record', fileExists('service-proofs', hold.path) && recordExists(hold.id), '');
check('a photo inside the window kept its file and its record', fileExists('service-proofs', fresh.path) && recordExists(fresh.id), '');
check('a legacy record was removed without touching anything else', !recordExists(legacy.id), '');
check('a record pointing at another bucket was removed but that file was not', !recordExists(crossBucket.id) && fileExists('payment-receipts', otherBucketFile), '');

console.log('\n=== a second run');
const second = await purgeExpiredServicePhotos(supabase);
check('finds nothing left to do', second.records === 0 && second.files === 0, JSON.stringify(second));
check('and the held and fresh photos are still there', recordExists(hold.id) && recordExists(fresh.id) && fileExists('service-proofs', hold.path) && fileExists('service-proofs', fresh.path), '');

console.log('\n=== the Business Hub window');
{
  const extra = { id: newId(), path: objectPath('window') };
  await put('service-proofs', extra.path);
  addRecord({ id: extra.id, storagePath: extra.path, monthsOld: 26 });
  sql(`update public.business_config set photo_retention_purge_months = 36 where id = (select id from public.business_config order by id limit 1);`);
  const held = await purgeExpiredServicePhotos(supabase);
  check('a longer window keeps a 26-month-old photo', held.records === 0 && recordExists(extra.id) && fileExists('service-proofs', extra.path), JSON.stringify(held));
  sql(`update public.business_config set photo_retention_purge_months = 24 where id = (select id from public.business_config order by id limit 1);`);
  const released = await purgeExpiredServicePhotos(supabase);
  check('the normal window then removes it, file and record', released.records === 1 && !recordExists(extra.id) && !fileExists('service-proofs', extra.path), JSON.stringify(released));
}

console.log('\n=== cleaning up');
await supabase.storage.from('service-proofs').remove([hold.path, fresh.path]);
await supabase.storage.from('payment-receipts').remove([otherBucketFile]);
sql(`set session_replication_role = replica; delete from public.service_photos where booking_id = '${B}' and storage_path like '%retention-${tag}%';`);
check('nothing the test stored is left behind', Number(sql(`select count(*) from storage.objects where name like '%retention-${tag}%'`)) === 0 && Number(sql(`select count(*) from public.service_photos where storage_path like '%retention-${tag}%'`)) === 0, '');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} retention checks passed.`);
process.exit(failed ? 1 : 0);
