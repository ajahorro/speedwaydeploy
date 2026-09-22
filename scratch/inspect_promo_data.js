// Reads the live promo records in detail (read-only).
const path = require('path');
require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({ path: path.resolve(__dirname, '../backend/.env') });
const { createClient } = require(path.resolve(__dirname, '../backend/node_modules/@supabase/supabase-js'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  console.log('=== LIVE PROMOS ===');
  const { data: promos, error } = await supabase.from('promos').select('*');
  if (error) { console.log('  error:', error.message); return; }
  promos.forEach(p => {
    console.log(`\n  id: ${p.id}`);
    console.log(`  title: ${p.title}`);
    console.log(`  discount: ${p.discount_value} (${p.discount_type})`);
    console.log(`  valid: ${p.valid_from} -> ${p.valid_until}`);
    console.log(`  active: ${p.is_active}`);
  });

  console.log('\n=== business_config.promo_rules (the legacy JSON path) ===');
  const { data: cfg } = await supabase.from('business_config').select('promo_rules').limit(1);
  console.log('  ' + JSON.stringify(cfg?.[0]?.promo_rules, null, 2).split('\n').join('\n  '));

  console.log('\n=== linked services / vehicle types ===');
  const { data: ps } = await supabase.from('promo_services').select('*');
  const { data: pvt } = await supabase.from('promo_vehicle_types').select('*');
  console.log('  promo_services:', JSON.stringify(ps));
  console.log('  promo_vehicle_types:', JSON.stringify(pvt));

  console.log('\n=== active_promo_services_view ===');
  const { data: view } = await supabase.from('active_promo_services_view').select('*');
  console.log('  cols:', view?.[0] ? Object.keys(view[0]).join(', ') : '(empty)');
  view?.slice(0, 5).forEach(v => console.log('  ' + JSON.stringify(v)));

  console.log('\n=== do any BOOKINGS use a promo yet? ===');
  const { data: withPromo, error: bpErr } = await supabase.from('bookings').select('id, applied_promo_id, promo_name_snapshot').not('applied_promo_id', 'is', null);
  if (bpErr) console.log('  error:', bpErr.message);
  else console.log(`  bookings with applied_promo_id: ${withPromo.length}`);
})();
