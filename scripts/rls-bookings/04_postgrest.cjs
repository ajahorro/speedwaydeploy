// Exercises the frontend's real PostgREST query shapes against the LOCAL scratch
// stack (127.0.0.1:56621) only. Keys below are the Supabase CLI's public local
// demo values, not secrets.
const crypto = require('crypto');
const { createClient } = require('../../backend/node_modules/@supabase/supabase-js');

const URL = 'http://127.0.0.1:56621';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (sub) => {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
};
const client = (sub) => createClient(URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: sub ? { headers: { Authorization: `Bearer ${sign(sub)}` } } : {},
});

const USERS = {
  anon: null,
  custA: 'aaaaaaaa-0000-4000-8000-000000000001',
  custB: 'aaaaaaaa-0000-4000-8000-000000000002',
  staffS: 'bbbbbbbb-0000-4000-8000-000000000001',
  admin: 'cccccccc-0000-4000-8000-000000000001',
};
const A1 = 'd0000000-0000-4000-8000-0000000000a1';
const B1 = 'd0000000-0000-4000-8000-0000000000b1';
const short = (rows) => (rows || []).map((r) => r.id.slice(-2)).sort().join(',') || 'none';

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
};

const CUSTOMER_LIST = `*,
  vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services!booking_vehicle_id(*)),
  payments:payments!payments_booking_id_fkey(*),
  assigned_staff:profiles!bookings_staff_id_fkey(first_name, last_name, email)`;
const ADMIN_LIST = `*,
  customer:profiles!bookings_customer_id_fkey(full_name, email),
  vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*),
  payments:payments!payments_booking_id_fkey(*)`;

(async () => {
  // --- anon ---------------------------------------------------------------
  {
    const sb = client(USERS.anon);
    const r = await sb.from('bookings').select('id');
    check('anon select bookings -> permission denied', r.error?.code, '42501');
    const u = await sb.from('bookings').update({ total_amount: 1 }).eq('id', A1).select('id');
    check('anon update bookings -> permission denied', u.error?.code, '42501');
    const o = await sb.rpc('get_schedule_occupancy', { p_start: '2026-11-10T00:00:00+08:00', p_end: '2026-11-11T00:00:00+08:00' });
    check('anon get_schedule_occupancy -> denied', o.error?.code, '42501');
    const c = await sb.rpc('create_booking_atomic_secure', { p_payload: {} });
    check('anon create_booking_atomic_secure -> denied', c.error?.code, '42501');
  }

  // --- customer A -----------------------------------------------------------
  {
    const sb = client(USERS.custA);
    const list = await sb.from('bookings').select(CUSTOMER_LIST).eq('customer_id', USERS.custA).order('created_at', { ascending: false });
    check('custA fetchCustomerBookings', [list.error, short(list.data), (list.data || []).flatMap((b) => b.vehicles).length], [null, 'a1,a2', 2]);
    check('custA assigned_staff embed visible on own booking', list.data?.find((b) => b.id === A1)?.assigned_staff !== undefined, true);
    const unfiltered = await sb.from('bookings').select('id');
    check('custA unfiltered select only returns own', short(unfiltered.data), 'a1,a2');
    const other = await sb.from('bookings').select(CUSTOMER_LIST).eq('id', B1).single();
    check('custA fetchBookingById(other) -> PGRST116 not found', other.error?.code, 'PGRST116');
    const billing = await sb.from('bookings')
      .select('*, payments:payments!payments_booking_id_fkey(*), vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services!booking_vehicle_id(*))')
      .eq('customer_id', USERS.custA).order('created_at', { ascending: false });
    check('custA CustomerBilling', [billing.error, short(billing.data)], [null, 'a1,a2']);
    const occ = await sb.rpc('get_schedule_occupancy', { p_start: '2026-11-10T00:00:00+08:00', p_end: '2026-11-11T00:00:00+08:00', p_exclude_booking_id: null });
    check('custA wizard occupancy (all customers, no ids)', [occ.error, occ.data?.length, Object.keys(occ.data?.[0] || {}).sort()], [null, 3, ['end_datetime', 'start_datetime', 'status', 'vehicles']]);
    const snap = await sb.rpc('capture_booking_qr_snapshot', { p_booking_id: A1 });
    check('custA capture_booking_qr_snapshot own', [snap.error, snap.data?.qr_account_name], [null, 'Speedway Test']);
    const snapOther = await sb.rpc('capture_booking_qr_snapshot', { p_booking_id: B1 });
    check('custA capture_booking_qr_snapshot other -> P0002', snapOther.error?.code, 'P0002');
    const upd = await sb.from('bookings').update({ total_amount: 1 }).eq('id', A1).select('id');
    check('custA direct update own -> 0 rows', [upd.error, upd.data?.length], [null, 0]);
    const chat = await sb.from('bookings').select('customer_id').eq('id', A1).maybeSingle();
    check('custA chat booking->customer lookup', chat.data?.customer_id, USERS.custA);
    const garage = await sb.from('booking_vehicles').select('id, booking:bookings(id, start_datetime, status, total_amount)').eq('plate_number', 'BBB222');
    check('custA garage history of another customer\'s plate hides booking', (garage.data || []).map((v) => v.booking), [null]);
  }

  // --- staff S --------------------------------------------------------------
  {
    const sb = client(USERS.staffS);
    const hist = await sb.from('booking_vehicles')
      .select('*, booking:bookings!booking_vehicles_booking_id_fkey!inner(staff_id, status, updated_at, total_amount), services:booking_vehicle_services(*)')
      .eq('booking.staff_id', USERS.staffS);
    check('staffS StaffWorkHistory !inner join', [hist.error, hist.data?.length], [null, 1]);
    const own = await sb.from('bookings').select('id');
    check('staffS sees only assigned', short(own.data), 'a1');
  }

  // --- admin ----------------------------------------------------------------
  {
    const sb = client(USERS.admin);
    const list = await sb.from('bookings').select(ADMIN_LIST).order('created_at', { ascending: false });
    check('admin useAdminBookings', [list.error, short(list.data)], [null, 'a1,a2,b1']);
    const pay = await sb.from('payments').select('*, booking:bookings!payments_booking_id_fkey(*, customer:profiles!bookings_customer_id_fkey(full_name, email))');
    check('admin AdminPayments payments->booking embed', pay.error, null);
    const cnt = await sb.from('bookings').select('*', { count: 'exact', head: true });
    check('admin dashboard total count', [cnt.error, cnt.count], [null, 3]);
    const det = await sb.from('bookings').select('*').eq('id', B1).maybeSingle();
    check('admin AdminBookingDetails load', det.data?.id, B1);
    const upd = await sb.from('bookings').update({ refund_status: 'QUEUED' }).eq('id', B1).select('id');
    check('admin update booking', [upd.error, upd.data?.length], [null, 1]);
    await sb.from('bookings').update({ refund_status: null }).eq('id', B1);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL POSTGREST CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
