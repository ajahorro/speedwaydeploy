// Inspect live schema of bookings + booking_vehicles so the seed is valid.
const path = require('path');
require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({ path: path.resolve(__dirname, '../backend/.env') });
const { createClient } = require(path.resolve(__dirname, '../backend/node_modules/@supabase/supabase-js'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  for (const table of ['bookings', 'booking_vehicles']) {
    // Probe one existing row to learn columns (empty tables fall back to insert errors).
    const { data, error } = await s.from(table).select('*').limit(1);
    console.log(`\n=== ${table} ===`);
    if (error) { console.log('ERR', error.message); continue; }
    if (data && data.length) {
      console.log('columns:', Object.keys(data[0]).join(', '));
      console.log('sample:', JSON.stringify(data[0]).slice(0, 600));
    } else {
      console.log('(empty) — inferring from a dry insert error below');
      const { error: insErr } = await s.from(table).insert({}).select().single();
      console.log('insert error:', insErr?.message);
    }
  }

  // Find staff1 profile.
  const { data: staff } = await s.from('profiles').select('id,role,full_name,email').eq('email', 'staff1@speedway.com');
  console.log('\nstaff1 profile:', JSON.stringify(staff));

  // Distinct statuses in use.
  const { data: st } = await s.from('bookings').select('status').limit(200);
  console.log('booking statuses seen:', [...new Set((st || []).map(r => r.status))]);
})();
