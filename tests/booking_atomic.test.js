// Regression test for the atomic booking-creation + refund-integrity migrations.
//
// Run with:  npm test          (root package.json)
//        or node tests/booking_atomic.test.js
//
// Validates the migrations against a real Postgres engine (PGlite/WASM),
// proving:
//   1. The migration files parse and execute.
//   2. create_booking_atomic writes booking + vehicles + services + payment.
//   3. ATOMICITY — a mid-transaction failure rolls back the WHOLE booking, so no
//      phantom booking (booking with no vehicles/payments) can ever be left
//      behind. This is the defect these migrations fix.
//   4. The integrity shield rejects a booking with no vehicles.
//   5. The repair migration heals the known phantom rows and removes the ghosts.
//   6. process_booking_refund writes its system chat line with a NON-NULL
//      sender_id (booking_messages.sender_id is NOT NULL; the old code passed
//      null and aborted the whole refund).
//
// The shims below mirror the LIVE Supabase schema (columns were probed against
// the real database), so column-name drift surfaces here as a failure.
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const dir = path.resolve(__dirname, '../supabase/migrations');
const rpcFile = '20261001000001_create_booking_atomic.sql';
const repairFile = '20261001000002_repair_phantom_bookings.sql';
const refundFixFile = '20261001000003_fix_refund_system_message_sender.sql';
// Fix for the payment_status text-vs-enum crash in create_booking_atomic.
const paymentStatusFixFile = '20261016000001_fix_create_booking_atomic_payment_status_enum.sql';
// Superseding fix that also casts payment_method + payments.payment_type.
const enumCastsFixFile = '20261016000002_fix_create_booking_atomic_enum_casts.sql';
// Final fix adding the bookings.vehicle_type enum cast.
const vehicleTypeFixFile = '20261016000003_fix_create_booking_atomic_vehicle_type_enum.sql';
// Promo/discount snapshot persistence (ledger + receipt correctness).
const promoSnapshotFile = '20261016000004_create_booking_atomic_promo_snapshot.sql';

// Shims mirror the REAL columns probed from the live Supabase DB.
const SHIMS = `
create schema if not exists auth;
create schema if not exists extensions;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

create table public.profiles (id uuid primary key default gen_random_uuid(), role text, full_name text);
-- Real enum probed from the live DB: booking_payment_status accepts lowercase
-- values only (unpaid | pending | paid | refunded).
create type booking_payment_status as enum ('unpaid', 'pending', 'paid', 'refunded');
-- Other real enum types probed from the live DB.
create type payment_method_type as enum ('GCASH', 'CASH', 'BANK_TRANSFER');
create type payment_type_enum as enum ('Full', 'Downpayment');
create type vehicle_type as enum ('sedan', 'suv', 'van', 'motorcycle');
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid, staff_id uuid, resource_id uuid,
  start_datetime timestamptz, end_datetime timestamptz,
  status text, payment_method payment_method_type,
  -- Mirrors the LIVE schema: bookings.payment_status is an ENUM, not text.
  -- Declaring it as text here is what previously HID the text->enum crash in
  -- create_booking_atomic(); the negative control below now locks it in.
  payment_status booking_payment_status default 'unpaid',
  total_amount numeric, estimated_duration_total int,
  customer_phone text, customer_notes text, vehicle_type vehicle_type,
  cancellation_reason text, cancelled_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  refund_status text, contact_number text, customer_name text, notes text,
  assigned_by uuid, assigned_at timestamptz, ocr_metadata jsonb default '{}',
  refund_notes text, email_sent_statuses text[] default '{}',
  next_morning_lock timestamptz, is_walk_in boolean default false,
  guest_name text, guest_email text, guest_phone text, payment_type text,
  balance_due numeric default 0, flagged_noshow_at timestamptz, restored_at timestamptz,
  cancellation_type text, needs_attention boolean default false, customer_email text,
  bay_id uuid, guest_first_name text, guest_last_name text, reminder_sent boolean default false,
  grace_period_until timestamptz, applied_promo_id uuid, promo_name_snapshot text,
  discount_amount_snapshot numeric default 0, active_qr_snapshot jsonb, qr_snapshot_version int,
  service_snapshot jsonb default '[]', service_snapshot_version int default 1
);

create table public.booking_vehicles (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete cascade,
  vehicle_type text, make text, model text, plate_number text, status text,
  subtotal numeric default 0, is_cancelled boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  brand text, service_notes text, photo_proof_url text,
  started_at timestamptz, completed_at timestamptz, staff_id uuid,
  assigned_at timestamptz, assigned_by uuid, fleet_group_id uuid
);

create table public.booking_vehicle_services (
  id uuid primary key default gen_random_uuid(),
  service_name_snapshot text, price_snapshot numeric, duration_snapshot int, step_order int default 0,
  created_at timestamptz default now(),
  booking_vehicle_id uuid references public.booking_vehicles(id) on delete cascade,
  price numeric, service_name text, service_id uuid, service_snapshot jsonb,
  final_price numeric, price_at_booking numeric, base_price numeric, vehicle_type text,
  service_version int default 1,
  constraint svc_price_check check (price >= 0)
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete cascade,
  amount numeric, method text, status text, receipt_url text, receipt_attempt int default 1,
  ocr_text text, reference_number text, refund_reason text, refunded_at timestamptz,
  refunded_by uuid, verified_by uuid, verified_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  notes text, payment_method text, sender_name text, recipient_name text,
  transaction_date timestamptz, refund_method text, rejection_reason text, evidence_url text,
  detected_amount numeric, detected_ref text, payment_type payment_type_enum, payment_status text,
  transfer_fee numeric default 0, net_credit numeric, credit_applied numeric default 0,
  excess_routed numeric default 0
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid, action_type text, actor_name text, actor_role text, details text,
  actor_id uuid, metadata jsonb, created_at timestamptz default now()
);

-- booking_messages mirrors the LIVE schema: sender_id is NOT NULL (the column
-- the old refund RPC violated) and is_system/message_text exist for system rows.
create table public.booking_messages (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid,
  sender_id uuid not null,
  message text,
  message_text text,
  message_type text,
  is_system boolean default false,
  is_read boolean default false,
  created_at timestamptz default now()
);

-- auth.uid() returns a fixed ADMIN id so the refund RPC's admin guard passes.
create or replace function auth.uid() returns uuid language sql stable as $$
  select '00000000-0000-0000-0000-00000000a000'::uuid
$$;

-- is_admin() referenced by grants in some migrations (not these, but keep parity).
create or replace function public.is_admin() returns boolean language sql stable as $$ select false $$;
`;

const q = async (db, sql) => (await db.query(sql)).rows;
const count = async (db, table, where = '') =>
  (await q(db, `select count(*)::int as n from public.${table} ${where}`))[0].n;

(async () => {
  const db = new PGlite();
  const asserts = [];
  try {
    await db.exec(SHIMS);
    console.log('-- shims applied --');

    // Apply the migrations verbatim (parse + execute check).
    await db.exec(fs.readFileSync(path.join(dir, rpcFile), 'utf8'));
    console.log(`PASS  ${rpcFile} (parsed + executed)`);

    // ---------- TEST 0: negative control — the ORIGINAL RPC must crash ----------
    // The original create_booking_atomic() passed `coalesce(booking->>'payment_status',
    // 'unpaid')` (TEXT) straight into the enum column, so on a real enum column
    // every booking aborted with:
    //   column "payment_status" is of type booking_payment_status
    //     but expression is of type text
    // We assert the crash here so the fix cannot silently regress and the harness
    // home (this test) now genuinely mirrors the live schema.
    const enumProbePayload = {
      booking: {
        customer_name: 'Enum Probe', start_datetime: '2026-10-01T00:00:00Z',
        end_datetime: '2026-10-01T01:00:00Z', status: 'scheduled', total_amount: 0,
      },
      vehicles: [{ vehicle: { vehicle_type: 'Sedan', plate_number: 'PROBE1', status: 'SCHEDULED' }, services: [] }],
      payment: null,
    };
    let originalRpcCrashed = false;
    try {
      await db.query(`select public.create_booking_atomic($1::jsonb)`, [JSON.stringify(enumProbePayload)]);
    } catch (e) {
      originalRpcCrashed = /payment_status|enum|text/i.test(e.message);
    }
    asserts.push(['negative control: original RPC crashes on a real enum column (text->enum)', originalRpcCrashed]);

    // ---------- Apply the payment_status fix ----------
    await db.exec(fs.readFileSync(path.join(dir, paymentStatusFixFile), 'utf8'));
    console.log(`PASS  ${paymentStatusFixFile} (parsed + executed)`);

    // ---------- Apply the superseding enum-casts fix ----------
    await db.exec(fs.readFileSync(path.join(dir, enumCastsFixFile), 'utf8'));
    console.log(`PASS  ${enumCastsFixFile} (parsed + executed)`);

    // ---------- Apply the vehicle_type enum-cast fix (final) ----------
    await db.exec(fs.readFileSync(path.join(dir, vehicleTypeFixFile), 'utf8'));
    console.log(`PASS  ${vehicleTypeFixFile} (parsed + executed)`);

    // ---------- Apply the promo-snapshot migration ----------
    await db.exec(fs.readFileSync(path.join(dir, promoSnapshotFile), 'utf8'));
    console.log(`PASS  ${promoSnapshotFile} (parsed + executed)`);

    // After the fix, the exact same payload must succeed.
    const fixedProbe = await db.query(`select public.create_booking_atomic($1::jsonb) as r`, [JSON.stringify(enumProbePayload)]);
    asserts.push(['fix: same payload now succeeds on the enum column', Boolean(fixedProbe.rows[0]?.r?.booking?.id)]);

    // Regression: the frontend uses catalog IDs like 'moto_2', which are not UUIDs.
    // The RPC must silently store them as NULL and continue, rather than aborting
    // the whole booking with "invalid input syntax for type uuid".
    const nonUuidServicePayload = {
      booking: {
        customer_name: 'Service ID Regression', start_datetime: '2026-10-01T00:00:00Z',
        end_datetime: '2026-10-01T01:00:00Z', status: 'scheduled', total_amount: 0,
      },
      vehicles: [{
        vehicle: { vehicle_type: 'motorcycle', plate_number: 'Moto-1', status: 'SCHEDULED' },
        services: [{
          service_name: 'Moto VIP',
          price: 250,
          final_price: 250,
          base_price: 250,
          duration_minutes: 60,
          vehicle_type: 'motorcycle',
          service_id: 'moto_2'
        }]
      }],
      payment: null,
    };
    const serviceIdRegression = await db.query(`select public.create_booking_atomic($1::jsonb) as r`, [JSON.stringify(nonUuidServicePayload)]);
    const serviceIdRows = await q(db, `select service_id from public.booking_vehicle_services where service_name = 'Moto VIP' order by created_at desc limit 1`);
    asserts.push(['regression: non-UUID service IDs do not crash the RPC', Boolean(serviceIdRegression.rows[0]?.r?.booking?.id)]);
    asserts.push(['regression: invalid service IDs are stored as NULL instead of UUID-casting', serviceIdRows.length > 0 && serviceIdRows[0].service_id === null]);

    // And an unexpected enum value must fall back to 'unpaid' rather than abort.
    const badEnumPayload = JSON.parse(JSON.stringify(enumProbePayload));
    badEnumPayload.booking.customer_name = 'Bad Enum';
    badEnumPayload.booking.payment_status = 'NOT_A_REAL_STATUS';
    let badEnumOk = false;
    try {
      const r = await db.query(`select public.create_booking_atomic($1::jsonb) as r`, [JSON.stringify(badEnumPayload)]);
      badEnumOk = r.rows[0]?.r?.booking?.payment_status === 'unpaid';
    } catch (e) { badEnumOk = false; }
    asserts.push(['fix: unknown payment_status falls back to unpaid (never 22P02)', badEnumOk]);

    // payment_method + payment_type must also survive the enum columns.
    const methodPayload = JSON.parse(JSON.stringify(enumProbePayload));
    methodPayload.booking.customer_name = 'Method Probe';
    methodPayload.booking.payment_method = 'GCash';   // display casing -> GCASH
    methodPayload.payment = { amount: 100, method: 'GCash', payment_type: 'full', status: 'PENDING' }; // 'full' -> 'Full'
    let methodOk = false;
    try {
      const r = await db.query(`select public.create_booking_atomic($1::jsonb) as r`, [JSON.stringify(methodPayload)]);
      methodOk = r.rows[0]?.r?.booking?.payment_method === 'GCASH';
    } catch (e) { methodOk = false; }
    asserts.push(['fix: payment_method "GCash" -> GCASH enum, payment_type "full" -> Full', methodOk]);

    // vehicle_type display label must normalise to the lowercase enum member.
    const vtPayload = JSON.parse(JSON.stringify(enumProbePayload));
    vtPayload.booking.customer_name = 'VT Probe';
    vtPayload.booking.vehicle_type = 'Van/L300';   // -> 'van'
    let vtOk = false;
    try {
      const r = await db.query(`select public.create_booking_atomic($1::jsonb) as r`, [JSON.stringify(vtPayload)]);
      vtOk = r.rows[0]?.r?.booking?.vehicle_type === 'van';
    } catch (e) { vtOk = false; }
    asserts.push(['fix: bookings.vehicle_type "Van/L300" -> van enum member', vtOk]);

    // Promo snapshot must land on the booking row (ledger/receipt correctness).
    const promoPayload = JSON.parse(JSON.stringify(enumProbePayload));
    promoPayload.booking.customer_name = 'Promo Probe';
    promoPayload.booking.promo_name_snapshot = 'Grand Opening 10%';
    promoPayload.booking.discount_amount_snapshot = 123;
    let promoOk = false;
    try {
      const r = await db.query(`select public.create_booking_atomic($1::jsonb) as r`, [JSON.stringify(promoPayload)]);
      const b = r.rows[0]?.r?.booking;
      promoOk = b?.promo_name_snapshot === 'Grand Opening 10%' && Number(b?.discount_amount_snapshot) === 123;
    } catch (e) { promoOk = false; }
    asserts.push(['promo snapshot persisted on booking (name + discount amount)', promoOk]);

    // Reset so the happy-path counts below start from a clean slate.
    await db.exec(`delete from public.booking_vehicles; delete from public.payments; delete from public.bookings;`);

    // ---------- TEST 1: happy path (walk-in with payment + vehicles) ----------
    const payload = {
      booking: {
        customer_name: 'Test Guest', customer_email: 'g@example.com',
        contact_number: '0917', start_datetime: '2026-10-01T02:00:00Z',
        end_datetime: '2026-10-01T03:00:00Z', status: 'confirmed',
        total_amount: 120, is_walk_in: true, notes: 'WALK-IN'
      },
      vehicles: [
        { vehicle: { vehicle_type: 'Regular', brand: 'Bracko', model: 'Bracko', plate_number: 'ABC1', status: 'SCHEDULED' },
          services: [{ service_name: 'Moto Wash', price: 120, final_price: 120, base_price: 120, price_at_booking: 120, vehicle_type: 'Regular', duration_minutes: 30 }] }
      ],
      payment: { amount: 120, method: 'Cash', payment_type: 'Full', status: 'PAID', notes: 'ADMIN_WALK_IN' }
    };
    const res2 = await db.query(`select public.create_booking_atomic($1::jsonb) as r`, [JSON.stringify(payload)]);
    const out = res2.rows[0].r;
    asserts.push(['RPC returns a booking row', out && out.booking && out.booking.id]);
    asserts.push(['RPC reports 1 vehicle id', Array.isArray(out.vehicle_ids) && out.vehicle_ids.length === 1]);

    asserts.push(['booking row written', (await count(db, 'bookings')) === 1]);
    asserts.push(['vehicle row written', (await count(db, 'booking_vehicles')) === 1]);
    asserts.push(['service row written', (await count(db, 'booking_vehicle_services')) === 1]);
    asserts.push(['payment row written', (await count(db, 'payments')) === 1]);

    // ---------- TEST 2: ATOMICITY — force a mid-TX failure ----------
    // The service price check constraint rejects a negative price, which fires
    // AFTER the booking row insert inside the function. The whole TX must roll back.
    const bad = JSON.parse(JSON.stringify(payload));
    bad.booking.customer_name = 'Rollback Me';
    bad.vehicles[0].services[0].price = -1;
    bad.vehicles[0].services[0].final_price = -1;
    bad.vehicles[0].services[0].base_price = -1;
    bad.vehicles[0].services[0].price_at_booking = -1;

    let threw = false;
    try {
      await db.query(`select public.create_booking_atomic($1::jsonb)`, [JSON.stringify(bad)]);
    } catch (e) {
      threw = true;
    }
    asserts.push(['atomic create rejected the bad payload', threw]);
    asserts.push(['NO phantom booking after failed create', (await count(db, 'bookings')) === 1]);
    asserts.push(['NO orphan vehicle after failed create', (await count(db, 'booking_vehicles')) === 1]);
    asserts.push(['NO orphan payment after failed create', (await count(db, 'payments')) === 1]);

    // ---------- TEST 3: integrity shield (no vehicles) ----------
    let shieldThrew = false;
    try {
      await db.query(`select public.create_booking_atomic($1::jsonb)`,
        [JSON.stringify({ booking: { total_amount: 5 }, vehicles: [], payment: null })]);
    } catch (e) { shieldThrew = true; }
    asserts.push(['integrity shield rejects empty-vehicle booking', shieldThrew]);

    // ---------- TEST 4: the repair migration heals the live phantoms ----------
    // Recreate the exact live rows the repair targets.
    await db.exec(`
      insert into public.bookings (id, status, total_amount, customer_name, customer_email, contact_number,
        start_datetime, end_datetime, payment_method, payment_type, notes, is_walk_in, refund_status)
      values ('7d1c46e4-d9d5-4f7a-aa61-9ff607aeecc5','FLAGGED_NOSHOW',120,'Marvs Jacobds','marvs933@gmail.com','09637549164',
        '2026-09-24T03:30:00Z','2026-09-24T05:00:00Z','GCASH','full',' WALK-IN',false,'PENDING');
      insert into public.bookings (id, status, total_amount, refund_status)
      values ('e5b3cf4b-8f96-4a95-8393-78d33a83f98a','FLAGGED_NOSHOW',0,'PENDING');
      insert into public.booking_vehicles (id, booking_id, status)
      values ('4c912062-bfd6-4f46-b9ad-ac3c8512f743', null, 'pending');
    `);
    // Re-run the repair migration against these rows.
    await db.exec(fs.readFileSync(path.join(dir, repairFile), 'utf8'));
    console.log(`PASS  ${repairFile} (parsed + executed)`);

    assertions: {
      const v = await count(db, 'booking_vehicles', `where booking_id='7d1c46e4-d9d5-4f7a-aa61-9ff607aeecc5'`);
      const s = await q(db, `select 1 from public.booking_vehicle_services s join public.booking_vehicles v on v.id=s.booking_vehicle_id where v.booking_id='7d1c46e4-d9d5-4f7a-aa61-9ff607aeecc5'`);
      const p = await count(db, 'payments', `where booking_id='7d1c46e4-d9d5-4f7a-aa61-9ff607aeecc5'`);
      const filled = await count(db, 'bookings', `where id='7d1c46e4-d9d5-4f7a-aa61-9ff607aeecc5' and is_walk_in = true`);
      const ghostGone = await count(db, 'bookings', `where id='e5b3cf4b-8f96-4a95-8393-78d33a83f98a'`);
      const orphanGone = await count(db, 'booking_vehicles', `where id='4c912062-bfd6-4f46-b9ad-ac3c8512f743'`);
      asserts.push(['repair: phantom 7d1c46e4 got its unit', v === 1]);
      asserts.push(['repair: phantom 7d1c46e4 got its service (Moto Wash)', s.length === 1]);
      asserts.push(['repair: phantom 7d1c46e4 got its payment', p === 1]);
      asserts.push(['repair: phantom 7d1c46e4 marked walk-in', filled === 1]);
      asserts.push(['repair: empty ghost e5b3cf4b deleted', ghostGone === 0]);
      asserts.push(['repair: dangling vehicle 4c912062 deleted', orphanGone === 0]);
    }

    // ---------- TEST 5: refund RPC system-message sender ----------
    // The refund RPC must write its chat line with a non-null sender_id, because
    // booking_messages.sender_id is NOT NULL. The old code passed null and the
    // whole refund aborted with a 400. Apply the fix migration and prove it.
    await db.exec(fs.readFileSync(path.join(dir, refundFixFile), 'utf8'));
    console.log(`PASS  ${refundFixFile} (parsed + executed)`);

    // Seed an admin profile + a paid booking the refund can act on.
    await db.exec(`
      insert into public.profiles (id, role, full_name)
      values ('00000000-0000-0000-0000-00000000a000', 'ADMIN', 'Refund Admin');
      insert into public.bookings (id, status, total_amount, refund_status)
      values ('00000000-0000-0000-0000-0000000000f1', 'FLAGGED_NOSHOW', 120, 'PENDING');
      insert into public.payments (booking_id, amount, status, method)
      values ('00000000-0000-0000-0000-0000000000f1', 120, 'PAID', 'GCash');
    `);

    let refundOk = false, refundErr = '';
    try {
      await db.query(
        `select public.process_booking_refund($1::uuid, $2::numeric, $3::text, $4::text, $5::uuid)`,
        ['00000000-0000-0000-0000-0000000000f1', 120, 'Test refund', 'RFD-TEST-1', '00000000-0000-0000-0000-00000000a000']
      );
      refundOk = true;
    } catch (e) { refundErr = e.message; }

    asserts.push([`refund RPC completes without a sender_id violation${refundOk ? '' : ' — ' + refundErr}`, refundOk]);

    if (refundOk) {
      const msgs = await q(db, `select sender_id, is_system, message_type from public.booking_messages where booking_id='00000000-0000-0000-0000-0000000000f1' and message_type='system'`);
      asserts.push(['refund wrote exactly one system chat line', msgs.length === 1]);
      asserts.push(['system chat line has a NON-NULL sender_id', msgs[0] && msgs[0].sender_id !== null]);
      asserts.push(['system chat line is flagged is_system', msgs[0] && msgs[0].is_system === true]);
      const refundRow = await q(db, `select amount, method, status from public.payments where booking_id='00000000-0000-0000-0000-0000000000f1' and method='SYSTEM_REFUND'`);
      asserts.push(['negative SYSTEM_REFUND ledger row written', refundRow.length === 1 && Number(refundRow[0].amount) === -120]);
      const closed = await q(db, `select refund_status from public.bookings where id='00000000-0000-0000-0000-0000000000f1'`);
      asserts.push(['booking refund_status set to PROCESSED', closed[0] && closed[0].refund_status === 'PROCESSED']);
    }

    // ---------- TEST 6: negative control for the refund bug ----------
    // Prove the schema still enforces what the old code violated: a system chat
    // line with sender_id = null MUST be rejected. If this ever stops throwing,
    // the guard that motivated the fix has silently gone away.
    let nullSenderRejected = false;
    try {
      await db.query(`insert into public.booking_messages (booking_id, sender_id, message, message_type) values ($1::uuid, null, 'x', 'system')`,
        ['00000000-0000-0000-0000-0000000000f1']);
    } catch (e) { nullSenderRejected = true; }
    asserts.push(['negative control: null sender_id is rejected by the schema', nullSenderRejected]);

    console.log('\n-- assertions --');
    let pass = 0, fail = 0;
    for (const [label, cond] of asserts) {
      if (cond) { pass++; console.log(`PASS  ${label}`); }
      else { fail++; console.log(`FAIL  ${label}`); }
    }
    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('HARNESS ERROR:', e.message);
    process.exitCode = 1;
  }
})();