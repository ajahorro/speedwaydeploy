// Purge any orphaned service-proofs objects left by earlier seed runs.
const path = require('path');
require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({ path: path.resolve(__dirname, '../backend/.env') });
const { createClient } = require(path.resolve(__dirname, '../backend/node_modules/@supabase/supabase-js'));

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Recursively collect object paths under a prefix.
const listAll = async (prefix = '') => {
  const { data: entries } = await s.storage.from('service-proofs').list(prefix, { limit: 1000 });
  let files = [];
  for (const e of entries || []) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    // A folder has no metadata/id; a file does.
    if (e.id === null || e.metadata === null) {
      files = files.concat(await listAll(p));
    } else {
      files.push(p);
    }
  }
  return files;
};

(async () => {
  const all = await listAll('');
  console.log('objects found in bucket:', all.length);
  if (all.length) {
    console.log(all.join('\n'));
    const { error } = await s.storage.from('service-proofs').remove(all);
    console.log(error ? 'remove error: ' + error.message : `removed ${all.length} object(s)`);
  }
  const after = await listAll('');
  console.log('\nremaining objects:', after.length);
  process.exit(after.length === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
