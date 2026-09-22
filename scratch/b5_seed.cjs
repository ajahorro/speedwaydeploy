// Batch 5 interactive sweep — SEED.
// Creates a disposable booking + vehicle assigned to staff1@speedway.com so the
// staff dashboard exposes a task card, then writes the ids to a handoff file for
// the sweep + cleanup steps. Idempotent-ish: re-running first cleans any prior
// seed (matched by the sentinel note) before creating a fresh one.
const path = require('path');
const fs = require('fs');
require(path.resolve(__dirname, '../backend/node_modules/dotenv')).config({ path: path.resolve(__dirname, '../backend/.env') });
const { createClient } = require(path.resolve(__dirname, '../backend/node_modules/@supabase/supabase-js'));

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const HANDOFF = path.resolve(__dirname, 'b5_seed_handoff.json');
const SENTINEL = '__BATCH5_E2E_SEED__';

(async () => {
  // 0. Purge any prior seed first (idempotent re-run).
  const { data: prior } = await s.from('bookings').select('id').eq('customer_notes', SENTINEL);
  for (const row of prior || []) {
    await s.from('booking_vehicles').delete().eq('booking_id', row.id);
    await s.from('service_photos').delete().eq('booking_id', row.id);
    await s.from('bookings').delete().eq('id', row.id);
  }

  // 1. Resolve staff1 + a customer profile.
  const { data: staffRows } = await s.from('profiles').select('id,role,full_name,email').eq('email', 'staff1@speedway.com');
  const staff = staffRows?.[0];
  if (!staff) throw new Error('staff1@speedway.com profile not found');

  const { data: custRows } = await s.from('profiles').select('id,full_name').eq('email', 'jayneahorro@gmail.com');
  const customer = custRows?.[0] || null;

  // 2. Build a "today" window so canStartTask() is satisfied.
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.max(0, now.getHours()), 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  // 3. Insert the booking (no payment due -> completion gate is purely photo-based).
  const { data: booking, error: bErr } = await s.from('bookings').insert({
    customer_id: customer?.id || null,
    staff_id: staff.id,
    status: 'confirmed',
    start_datetime: start.toISOString(),
    end_datetime: end.toISOString(),
    total_amount: 0,
    customer_name: customer?.full_name || 'E2E Test Customer',
    customer_email: 'jayneahorro@gmail.com',
    customer_notes: SENTINEL,
    is_walk_in: true
  }).select('id').single();
  if (bErr) throw new Error('booking insert: ' + bErr.message);

  // 4. Insert the vehicle unit.
  const { data: vehicle, error: vErr } = await s.from('booking_vehicles').insert({
    booking_id: booking.id,
    vehicle_type: 'Sedan',
    brand: 'Toyota',
    make: 'Toyota',
    model: 'Vios E2E',
    plate_number: 'E2E-0001',
    status: 'PENDING',
    staff_id: staff.id,
    subtotal: 0
  }).select('id').single();
  if (vErr) throw new Error('vehicle insert: ' + vErr.message);

  const handoff = {
    sentinel: SENTINEL,
    bookingId: booking.id,
    vehicleId: vehicle.id,
    staffId: staff.id,
    staffEmail: staff.email,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(HANDOFF, JSON.stringify(handoff, null, 2));

  console.log('=== SEED CREATED ===');
  console.log(JSON.stringify(handoff, null, 2));
})().catch((e) => { console.error('SEED ERROR:', e.message); process.exit(1); });
