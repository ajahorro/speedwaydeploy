// booking_vehicles / booking_vehicle_services checks through PostgREST and
// Realtime with the frontend's real query shapes, against the LOCAL scratch
// stack (127.0.0.1:56621) only. Keys below are the Supabase CLI's public local
// demo values, not secrets.
//
// Needs 01_seed.sql + 05_vehicles_seed.sql loaded. supabase-js is resolved from
// SUPABASE_JS (a path) or backend/node_modules; in a git worktree without
// node_modules, point SUPABASE_JS at the main checkout's copy.
const crypto = require('crypto');
const path = require('path');
const { createClient } = require(process.env.SUPABASE_JS
  || path.join(__dirname, '../../backend/node_modules/@supabase/supabase-js'));

const URL = 'http://127.0.0.1:56621';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (sub) => {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
};
const client = (sub) => {
  const token = sub ? sign(sub) : null;
  const sb = createClient(URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  if (token) sb.realtime.setAuth(token);
  return sb;
};
const service = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const USERS = {
  custA: 'aaaaaaaa-0000-4000-8000-000000000001',
  custB: 'aaaaaaaa-0000-4000-8000-000000000002',
  staffS: 'bbbbbbbb-0000-4000-8000-000000000001',
  staffT: 'bbbbbbbb-0000-4000-8000-000000000002',
  admin: 'cccccccc-0000-4000-8000-000000000001',
};
const B1 = 'd0000000-0000-4000-8000-0000000000b1';
const V = (s) => `e0000000-0000-4000-8000-0000000000${s}`;
const short = (rows, key = 'id') => (rows || []).map((r) => r[key].slice(-2)).sort().join(',') || 'none';

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
};

// bookingService.fetchCustomerBookings / fetchBookingById
const CUSTOMER_LIST = `*,
  vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services!booking_vehicle_id(*)),
  payments:payments!payments_booking_id_fkey(*)`;
// garageService.fetchVehicleHistory
const GARAGE_HISTORY = `id, status, created_at,
  booking:bookings(id, start_datetime, status, total_amount),
  services:booking_vehicle_services(service_name, price)`;
// StaffWorkHistory
const WORK_HISTORY = `*,
  booking:bookings!booking_vehicles_booking_id_fkey!inner(staff_id, status, updated_at, total_amount),
  services:booking_vehicle_services(*)`;

// Subscribe like useBookings / UnifiedContext (no row filter) and collect the
// service_notes markers (or ids) of events delivered to this user.
const subscribe = (sb, label) => new Promise((resolve, reject) => {
  const seen = [];
  const channel = sb.channel(`rls-test-${label}-${Date.now()}`)
    // A role without SELECT gets a stub ({new: {}, old: {}, errors: ['Error 401: Unauthorized']})
    // rather than nothing; record only events that actually carry row data.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_vehicles' }, (p) => {
      const id = p.new?.id || p.old?.id;
      if (id || Object.keys(p.new || {}).length || Object.keys(p.old || {}).length) seen.push(p.new?.service_notes || id || JSON.stringify(p));
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve({ channel, seen });
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err || new Error(status));
    });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // --- anon -----------------------------------------------------------------
  {
    const sb = client(null);
    const v = await sb.from('booking_vehicles').select('id');
    check('anon select booking_vehicles -> permission denied', v.error?.code, '42501');
    const s = await sb.from('booking_vehicle_services').select('id');
    check('anon select booking_vehicle_services -> permission denied', s.error?.code, '42501');
    const u = await sb.from('booking_vehicles').update({ plate_number: 'X' }).eq('id', V('a1')).select('id');
    check('anon update booking_vehicles -> permission denied', u.error?.code, '42501');
    const d = await sb.from('booking_vehicle_services').delete().eq('booking_vehicle_id', V('a1')).select('id');
    check('anon delete booking_vehicle_services -> permission denied', d.error?.code, '42501');
    const n = await sb.rpc('update_booking_vehicle_service_notes', { p_vehicle_id: V('a1'), p_notes: 'x' });
    check('anon notes RPC -> denied', n.error?.code, '42501');
  }

  // --- customer A -------------------------------------------------------------
  {
    const sb = client(USERS.custA);
    const list = await sb.from('bookings').select(CUSTOMER_LIST).eq('customer_id', USERS.custA).order('created_at', { ascending: false });
    const vehicles = (list.data || []).flatMap((b) => b.vehicles);
    check('custA fetchCustomerBookings embeds own vehicles + services',
      [list.error, short(vehicles), vehicles.flatMap((v) => v.services).length], [null, 'a1,a2,a3', 3]);
    const det = await sb.from('booking_vehicles').select('*').eq('booking_id', B1).order('created_at');
    check('custA CustomerBookingDetails vehicles of other booking -> []', [det.error, det.data?.length], [null, 0]);
    const svc = await sb.from('booking_vehicle_services').select('*').in('booking_vehicle_id', [V('b1'), V('b2')]);
    check('custA service lines of other customer -> []', [svc.error, svc.data?.length], [null, 0]);
    const other = await sb.from('bookings').select(CUSTOMER_LIST).eq('id', B1).single();
    check('custA fetchBookingById(other) -> PGRST116', other.error?.code, 'PGRST116');
    const gOther = await sb.from('booking_vehicles').select(GARAGE_HISTORY).eq('plate_number', 'BBB222').order('created_at', { ascending: false });
    check('custA garage history of another customer\'s plate -> []', [gOther.error, gOther.data?.length], [null, 0]);
    const gOwn = await sb.from('booking_vehicles').select(GARAGE_HISTORY).eq('plate_number', 'AAA111').order('created_at', { ascending: false });
    check('custA garage history own plate (bookings + services embedded)',
      [gOwn.error, gOwn.data?.length, (gOwn.data || []).every((v) => v.booking && v.services.length === 1)], [null, 3, true]);
    const upd = await sb.from('booking_vehicles').update({ plate_number: 'X' }).eq('id', V('a1')).select('id');
    check('custA direct update own vehicle -> 0 rows', [upd.error, upd.data?.length], [null, 0]);
    const ins = await sb.from('booking_vehicle_services').insert({ booking_vehicle_id: V('a1'), service_name: 'Free', price: 0 }).select('id');
    check('custA insert service line -> RLS violation', ins.error?.code, '42501');
  }

  // --- staff S ----------------------------------------------------------------
  {
    const sb = client(USERS.staffS);
    const h1 = await sb.from('booking_vehicles').select(WORK_HISTORY)
      .eq('booking.staff_id', USERS.staffS).in('status', ['COMPLETED', 'CANCELLED']).order('id', { ascending: false });
    check('staffS StaffWorkHistory assigned units', [h1.error, short(h1.data), h1.data?.[0]?.services?.length], [null, 'a3', 1]);
    const h2 = await sb.from('booking_vehicles').select(WORK_HISTORY)
      .in('id', [V('a3'), V('b1')]).in('status', ['COMPLETED', 'CANCELLED']).order('id', { ascending: false });
    check('staffS StaffWorkHistory by id cannot pull unassigned unit', [h2.error, short(h2.data)], [null, 'a3']);
    const direct = await sb.from('booking_vehicles').update({ service_notes: 'direct' }).eq('id', V('a1')).select('id');
    check('staffS old direct notes update -> 0 rows', [direct.error, direct.data?.length], [null, 0]);
    const rpc = await sb.rpc('update_booking_vehicle_service_notes', { p_vehicle_id: V('a1'), p_notes: 'Scratch on left door' });
    check('staffS handleSaveNotes RPC', [rpc.error, rpc.data], [null, 'Scratch on left door']);
    const back = await sb.from('booking_vehicles').select('service_notes').eq('id', V('a1')).single();
    check('staffS sees saved notes', back.data?.service_notes, 'Scratch on left door');
    const other = await sb.rpc('update_booking_vehicle_service_notes', { p_vehicle_id: V('b1'), p_notes: 'x' });
    check('staffS notes RPC on unassigned vehicle -> P0002', other.error?.code, 'P0002');
    await service.from('booking_vehicles').update({ service_notes: null }).eq('id', V('a1'));
  }

  // --- staff T ----------------------------------------------------------------
  {
    const sb = client(USERS.staffT);
    const all = await sb.from('booking_vehicles').select('id');
    check('staffT sees only assigned vehicles', short(all.data), 'b1,b2');
  }

  // --- admin ------------------------------------------------------------------
  {
    const sb = client(USERS.admin);
    const list = await sb.from('bookings').select(`*,
      customer:profiles!bookings_customer_id_fkey(full_name, email),
      vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*),
      payments:payments!payments_booking_id_fkey(*)`).order('created_at', { ascending: false });
    check('admin useAdminBookings vehicles embed', [list.error, (list.data || []).flatMap((b) => b.vehicles).length], [null, 5]);
    const dash = await sb.from('booking_vehicles').select('status');
    check('admin AdminDashboard vehicle status scan', [dash.error, dash.data?.length], [null, 5]);
    const busy = await sb.from('booking_vehicles').select('booking_id, status, bookings!inner(staff_id)').eq('status', 'SCHEDULED');
    check('admin AdminBookingDetails busy-staff join', [busy.error, busy.data?.length], [null, 4]);
    const ins = await sb.from('booking_vehicle_services').insert({ booking_vehicle_id: V('b1'), service_name: 'Wax', price: 300 }).select('id');
    check('admin insert service line', [ins.error, ins.data?.length], [null, 1]);
    if (ins.data?.[0]) await sb.from('booking_vehicle_services').delete().eq('id', ins.data[0].id);
  }

  // --- realtime ---------------------------------------------------------------
  try {
    const subA = await subscribe(client(USERS.custA), 'custA');
    const subAnon = await subscribe(client(null), 'anon');
    // Realtime can replay WAL from just before SUBSCRIBED, so tag this run's
    // updates and assert only on those markers.
    const tag = `rt-${Date.now()}`;
    await sleep(2000);
    await service.from('booking_vehicles').update({ service_notes: `${tag}-a1` }).eq('id', V('a1'));
    await service.from('booking_vehicles').update({ service_notes: `${tag}-b1` }).eq('id', V('b1'));
    for (let i = 0; i < 20 && !subA.seen.includes(`${tag}-a1`); i += 1) await sleep(500);
    await sleep(1000);
    const mine = (seen) => seen.filter((m) => typeof m === 'string' && m.startsWith(tag)).sort();
    check('realtime: custA receives only own vehicle changes', mine(subA.seen), [`${tag}-a1`]);
    check('realtime: anon receives no vehicle row data', subAnon.seen, []);
    await service.from('booking_vehicles').update({ service_notes: null }).in('id', [V('a1'), V('b1')]);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  realtime subscribe  ${err?.message || err}`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL VEHICLE POSTGREST/REALTIME CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
