// Batch 5 interactive sweep — CLEANUP.
// Reads the seed handoff and purges the booking, vehicle, photos (DB rows +
// private-bucket storage objects), and any audit rows created during the sweep.
const path = require('path');
const fs = require('fs');
require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({ path: path.resolve(__dirname, '../backend/.env') });
const { createClient } = require(path.resolve(__dirname, '../backend/node_modules/@supabase/supabase-js'));

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const HANDOFF = path.resolve(__dirname, 'b5_seed_handoff.json');
const SENTINEL = '__BATCH5_E2E_SEED__';

(async () => {
  let targets = [];
  if (fs.existsSync(HANDOFF)) {
    const h = JSON.parse(fs.readFileSync(HANDOFF, 'utf8'));
    targets.push(h.bookingId);
  }
  // Also sweep any sentinel bookings (belt-and-braces if handoff was lost).
  const { data: extra } = await s.from('bookings').select('id').eq('customer_notes', SENTINEL);
  targets = [...new Set([...targets, ...(extra || []).map(r => r.id)].filter(Boolean))];

  let deletedObjects = 0;
  for (const bookingId of targets) {
    // 1. Collect storage objects for this booking and remove them.
    const { data: photos } = await s.from('service_photos').select('id,storage_path').eq('booking_id', bookingId);
    const paths = (photos || [])
      .map(p => p.storage_path)
      .filter(p => p && !/^https?:\/\//i.test(p)); // skip legacy absolute URLs
    if (paths.length) {
      const { error: rmErr } = await s.storage.from('service-proofs').remove(paths);
      if (rmErr) console.warn('storage remove warning:', rmErr.message);
      else deletedObjects += paths.length;
    }

    // 2. Delete rows (photos -> vehicles -> booking).
    await s.from('service_photos').delete().eq('booking_id', bookingId);
    await s.from('booking_vehicles').delete().eq('booking_id', bookingId);
    await s.from('audit_logs').delete().eq('booking_id', bookingId);
    await s.from('bookings').delete().eq('id', bookingId);
    console.log(`purged booking ${bookingId}`);
  }

  if (fs.existsSync(HANDOFF)) fs.unlinkSync(HANDOFF);

  // 3. Verify nothing remains.
  const { count: bLeft } = await s.from('bookings').select('*', { count: 'exact', head: true }).eq('customer_notes', SENTINEL);
  const { count: pLeft } = await s.from('service_photos').select('*', { count: 'exact', head: true });

  console.log('\n=== CLEANUP COMPLETE ===');
  console.log(`storage objects removed : ${deletedObjects}`);
  console.log(`sentinel bookings left  : ${bLeft || 0}`);
  console.log(`service_photos rows left: ${pLeft || 0}`);

  // 4. Confirm the bucket holds no leftover e2e objects (list root folders).
  const { data: leftovers } = await s.storage.from('service-proofs').list('', { limit: 100 });
  console.log(`storage root entries     : ${(leftovers || []).length}`);
  if ((leftovers || []).length) console.log('  entries:', leftovers.map(o => o.name).join(', '));

  process.exit((bLeft || 0) === 0 && (pLeft || 0) === 0 ? 0 : 1);
})().catch((e) => { console.error('CLEANUP ERROR:', e.message); process.exit(1); });
