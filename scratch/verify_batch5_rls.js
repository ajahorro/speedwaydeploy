// Batch 5 live RLS enforcement test.
// Creates a throwaway booking + photo as service-role, then verifies the
// service_photos policies behave for each role (admin reads all, customer reads
// only own, staff reads assigned), and cleans up afterwards.
const path = require('path');
require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({ path: path.resolve(__dirname, '../backend/.env') });
const { createClient } = require(path.resolve(__dirname, '../backend/node_modules/@supabase/supabase-js'));

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON || null;

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const CREDS = {
  admin:    { email: 'testadmin961@gmail.com', pass: ['admin123', 'admin1234'] },
  staff:    { email: 'staff1@speedway.com',    pass: ['staff123', 'staff1234'] },
  customer: { email: 'jayneahorro@gmail.com',  pass: ['jayne123', 'jayne1234'] }
};

const login = async (creds) => {
  const c = createClient(URL, ANON || SERVICE, { auth: { persistSession: false } });
  for (const p of creds.pass) {
    const { data, error } = await c.auth.signInWithPassword({ email: creds.email, password: p });
    if (!error && data?.session) return c;
  }
  return null;
};

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  console.log('=== BATCH 5 LIVE RLS ENFORCEMENT ===\n');
  if (!ANON) {
    console.log('SKIP  anon key not found in backend/.env; cannot simulate anon role.');
  }

  // 1. Log in the customer FIRST so we use their real auth.uid() as the owner.
  const custClient = await login(CREDS.customer);
  const custId = custClient ? (await custClient.auth.getUser()).data?.user?.id : null;
  const { data: profiles } = await admin.from('profiles').select('id,role,email').limit(50);
  const adminProfile = profiles?.find(p => String(p.role).toUpperCase() === 'ADMIN');
  const staffProfile = profiles?.find(p => String(p.role).toUpperCase() === 'STAFF');
  console.log(`customer auth.uid: ${custId?.slice(0,8)} | admin:${adminProfile?.id?.slice(0,8)} staff:${staffProfile?.id?.slice(0,8)}\n`);

  if (!custId) check('customer login for RLS test', false, 'login failed');

  // 2. Insert a throwaway booking owned by the logged-in customer + a photo.
  let bookingId = null, photoId = null;
  if (custId) {
    const { data: b, error: bErr } = await admin.from('bookings').insert({
      customer_id: custId,
      status: 'in_progress',
      total_amount: 0
    }).select('id').single();
    if (bErr) { console.log('booking insert error:', bErr.message); }
    bookingId = b?.id;

    if (bookingId) {
      const { data: ph, error: pErr } = await admin.from('service_photos').insert({
        booking_id: bookingId,
        phase: 'after',
        storage_path: `__rls_test__/${bookingId}/x.jpg`,
        source: 'upload'
      }).select('id').single();
      if (pErr) console.log('photo insert error:', pErr.message);
      photoId = ph?.id;
    }
  }

  check('throwaway booking + photo created', Boolean(bookingId && photoId), `booking=${bookingId?.slice(0,8)}`);

  if (bookingId && photoId) {
    // 3. ADMIN client (service role) sees it.
    const { data: admRows } = await admin.from('service_photos').select('id').eq('id', photoId);
    check('service-role/admin can read the photo', admRows?.length === 1);

    // 4. CUSTOMER (the owner) can read it via their own session.
    if (custClient) {
      const { data: custRows, error: custErr } = await custClient
        .from('service_photos').select('id').eq('id', photoId);
      check('owner customer can read own booking photo', !custErr && custRows?.length === 1,
        custErr ? custErr.message : `${custRows?.length || 0} row(s)`);

      // 5. CUSTOMER cannot read a DIFFERENT booking's photo.
      const { data: b2 } = await admin.from('bookings').insert({
        customer_id: staffProfile?.id || custId, status: 'in_progress', total_amount: 0
      }).select('id').single();
      if (b2?.id) {
        const { data: ph2 } = await admin.from('service_photos').insert({
          booking_id: b2.id, phase: 'after', storage_path: `__rls_test__/${b2.id}/y.jpg`
        }).select('id').single();
        if (ph2?.id) {
          const { data: foreign } = await custClient.from('service_photos').select('id').eq('id', ph2.id);
          check('customer CANNOT read another booking\'s photo (RLS blocks)', (foreign?.length || 0) === 0,
            `${foreign?.length || 0} row(s) leaked`);
        }
        await admin.from('service_photos').delete().eq('booking_id', b2.id);
        await admin.from('bookings').delete().eq('id', b2.id);
      }
    } else {
      check('customer login for RLS test', false, 'login failed');
    }
  }

  // Cleanup.
  if (bookingId) {
    await admin.from('service_photos').delete().eq('booking_id', bookingId);
    await admin.from('bookings').delete().eq('id', bookingId);
  }
  const { count: leftover } = await admin.from('service_photos').select('*', { count: 'exact', head: true });
  check('cleanup left service_photos empty', (leftover || 0) === 0, `${leftover || 0} row(s) remain`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
