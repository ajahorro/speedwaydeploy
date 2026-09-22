// Verifies the live Supabase schema for the promo subsystem, read-only.
const path = require('path');
require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({ path: path.resolve(__dirname, '../backend/.env') });
const { createClient } = require(path.resolve(__dirname, '../backend/node_modules/@supabase/supabase-js'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const probe = async (label, fn) => {
  try {
    const result = await fn();
    console.log(`  ${label.padEnd(46)} ${result}`);
  } catch (error) {
    console.log(`  ${label.padEnd(46)} ERROR: ${error.message}`);
  }
};

(async () => {
  console.log('=== PROMO TABLES ===');
  for (const table of ['promos', 'promo_services', 'promo_vehicle_types']) {
    await probe(table, async () => {
      const { error, count } = await supabase.from(table).select('*', { count: 'exact', head: true });
      if (error) return 'MISSING (' + error.message.slice(0, 60) + ')';
      return `EXISTS — ${count} row(s)`;
    });
  }

  console.log('\n=== PROMO VIEW ===');
  await probe('active_promo_services_view', async () => {
    const { error, count } = await supabase.from('active_promo_services_view').select('*', { count: 'exact', head: true });
    if (error) return 'MISSING (' + error.message.slice(0, 60) + ')';
    return `EXISTS — ${count} row(s)`;
  });

  console.log('\n=== business_config.promo_rules COLUMN ===');
  await probe('business_config.promo_rules', async () => {
    const { data, error } = await supabase.from('business_config').select('promo_rules').limit(1);
    if (error) return 'MISSING (' + error.message.slice(0, 60) + ')';
    const value = data?.[0]?.promo_rules;
    const shape = value == null ? 'NULL' : Array.isArray(value) ? `array(${value.length})` : typeof value;
    return `EXISTS — value shape: ${shape}`;
  });

  console.log('\n=== bookings promo snapshot COLUMNS ===');
  await probe('bookings.applied_promo_id', async () => {
    const { error } = await supabase.from('bookings').select('applied_promo_id').limit(1);
    return error ? 'MISSING (' + error.message.slice(0, 60) + ')' : 'EXISTS';
  });
  await probe('bookings.promo_name_snapshot', async () => {
    const { error } = await supabase.from('bookings').select('promo_name_snapshot').limit(1);
    return error ? 'MISSING (' + error.message.slice(0, 60) + ')' : 'EXISTS';
  });

  console.log('\n=== applied migrations (supabase_migrations) ===');
  await probe('migration history readable', async () => {
    const { data, error } = await supabase.from('supabase_migrations.schema_migrations').select('*').limit(200);
    if (error) return 'not readable via API (' + error.message.slice(0, 50) + ')';
    return `${data.length} migration(s) recorded`;
  });

  console.log('\n=== promo data currently live ===');
  for (const table of ['promos', 'promo_services', 'promo_vehicle_types']) {
    await probe(table + ' sample', async () => {
      const { data, error } = await supabase.from(table).select('*').limit(3);
      if (error) return 'ERROR';
      if (!data?.length) return 'empty';
      const keys = Object.keys(data[0]).slice(0, 10).join(', ');
      return `cols: ${keys}`;
    });
  }
})();
