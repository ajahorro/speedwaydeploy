// Add a real photo to the seeded booking so the admin gallery has content.
// Uploads a tiny valid PNG to the private bucket + inserts a service_photos row.
const path = require('path');
const fs = require('fs');
require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({ path: path.resolve(__dirname, '../backend/.env') });
const { createClient } = require(path.resolve(__dirname, '../backend/node_modules/@supabase/supabase-js'));

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const HANDOFF = path.resolve(__dirname, 'b5_seed_handoff.json');

// 1x1 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

(async () => {
  const h = JSON.parse(fs.readFileSync(HANDOFF, 'utf8'));

  const results = [];
  for (const phase of ['before', 'after']) {
    const storagePath = `${h.bookingId}/${h.vehicleId}/${phase}/e2e.png`;
    const { error: upErr } = await s.storage.from('service-proofs').upload(storagePath, PNG, {
      contentType: 'image/png', upsert: true
    });
    if (upErr) { console.warn(`upload(${phase}) warning:`, upErr.message); }

    const { error: insErr } = await s.from('service_photos').insert({
      booking_id: h.bookingId,
      booking_vehicle_id: h.vehicleId,
      phase,
      storage_path: storagePath,
      caption: `E2E ${phase} evidence`,
      source: 'upload'
    });
    if (insErr) { console.warn(`insert(${phase}) warning:`, insErr.message); }
    results.push({ phase, storagePath, ok: !insErr });
  }

  console.log('=== SEED PHOTOS ADDED ===');
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
