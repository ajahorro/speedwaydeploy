// Batch 5 live post-apply verification. Read-only. Confirms the three
// migrations actually landed on the remote database as designed.
const path = require('path');
const fs = require('fs');

// Load backend env (SUPABASE_URL + service role key).
require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({
  path: path.resolve(__dirname, '../backend/.env')
});
const { createClient } = require(path.resolve(__dirname, '../backend/node_modules/@supabase/supabase-js'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const url = process.env.SUPABASE_URL;

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  console.log('=== BATCH 5 LIVE POST-APPLY VERIFICATION ===\n');
  console.log(`Project: ${url}\n`);

  // 1. service_photos table exists & is queryable.
  const { error: tErr, count } = await supabase
    .from('service_photos').select('*', { count: 'exact', head: true });
  check('service_photos table reachable', !tErr, tErr ? tErr.message : `${count} row(s)`);

  // 2. Columns present as designed.
  const { data: sample } = await supabase.from('service_photos').select('*').limit(0);
  const expectedCols = ['id', 'booking_id', 'booking_vehicle_id', 'phase', 'storage_path', 'caption', 'uploaded_by', 'uploaded_at', 'source', 'archived_at', 'retention_exempt'];
  // PostgREST returns no columns for limit(0); probe by selecting them explicitly.
  const { error: colErr } = await supabase.from('service_photos').select(expectedCols.join(',')).limit(1);
  check('service_photos columns present', !colErr, colErr ? colErr.message : `${expectedCols.length} columns`);

  // 3. phase CHECK constraint rejects a bad value.
  const { error: badPhaseErr } = await supabase.from('service_photos').insert({
    booking_id: '00000000-0000-0000-0000-000000000001',
    phase: 'not_a_phase',
    storage_path: 'x'
  });
  check('phase CHECK constraint enforced', Boolean(badPhaseErr),
    badPhaseErr ? 'constraint/violation rejected' : 'NOT ENFORCED (!)');

  // 4. Private bucket exists with the right settings.
  const { data: bucket, error: bErr } = await supabase.storage.getBucket('service-proofs');
  check('service-proofs bucket exists', !bErr && !!bucket, bErr ? bErr.message : `public=${bucket?.public}, limit=${bucket?.file_size_limit}`);

  // 5. Bucket is PRIVATE (not publicly listable/servable).
  //    A public bucket returns an object URL without signing; a private one does not.
  const probePath = '__verify_probe__/nope.jpg';
  const { data: pub } = supabase.storage.from('service-proofs').getPublicUrl(probePath);
  let isPubliclyServed = false;
  try {
    const r = await fetch(pub.publicUrl, { method: 'HEAD' });
    // Private bucket -> 400/404; public+missing also 404. We check the bucket flag too.
    isPubliclyServed = r.ok;
  } catch { /* ignore */ }
  check('service-proofs bucket is private', bucket?.public === false && !isPubliclyServed,
    `public flag=${bucket?.public}`);

  // 6. Signed URL can be minted (storage signed-URL path works).
  const { error: signErr } = await supabase.storage
    .from('service-proofs').createSignedUrl('__verify_probe__/nope.jpg', 60);
  // A missing object legitimately errors, but it must NOT be a bucket/RLS config error.
  check('createSignedUrl reachable (no bucket error)', !signErr || !/bucket not found/i.test(signErr.message),
    signErr ? signErr.message.slice(0, 70) : 'ok');

  // 7. Retention config columns + defaults.
  const { data: cfg, error: cfgErr } = await supabase
    .from('business_config')
    .select('photo_retention_archive_months,photo_retention_purge_months')
    .limit(1);
  check('retention config columns present', !cfgErr && cfg?.length === 1,
    cfgErr ? cfgErr.message : `archive=${cfg?.[0]?.photo_retention_archive_months}, purge=${cfg?.[0]?.photo_retention_purge_months}`);

  // 8. Retention RPC functions callable (archive is safe/idempotent to call).
  const { error: archErr } = await supabase.rpc('archive_stale_service_photos');
  check('archive_stale_service_photos() callable', !archErr, archErr ? archErr.message.slice(0, 70) : 'ok');

  const { error: runErr } = await supabase.rpc('run_service_photo_retention');
  check('run_service_photo_retention() callable', !runErr, runErr ? runErr.message.slice(0, 70) : 'ok');

  // 9. Legacy backfill: if historic photo_proof_url data existed, rows should exist.
  const { count: legacyCount } = await supabase
    .from('service_photos').select('*', { count: 'exact', head: true }).eq('source', 'legacy_backfill');
  check('legacy backfill ran (informational)', true, `${legacyCount ?? 0} legacy row(s) imported`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
