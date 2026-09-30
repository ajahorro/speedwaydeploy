const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261021000010_booking_scoped_verified_credit.sql'),
  'utf8'
);

const bootstrap = `
create schema auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-0000-0000-000000000099'::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create or replace function public.is_admin() returns boolean language sql stable as $$ select true $$;
create table public.bookings (
  id uuid primary key,
  customer_id uuid,
  total_amount numeric,
  status text default 'scheduled',
  refund_status text,
  refund_notes text,
  updated_at timestamptz default now()
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id),
  amount numeric,
  method text,
  status text,
  reference_number text,
  refund_reason text,
  notes text,
  refunded_at timestamptz,
  refunded_by uuid,
  detected_amount numeric,
  transfer_fee numeric default 0,
  created_at timestamptz default now()
);
create table public.customer_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  booking_id uuid references public.bookings(id),
  entry_type text not null check (entry_type in ('EXCESS', 'ABSORBED', 'REFUND_QUEUED', 'ADJUSTMENT')),
  amount numeric not null,
  balance_after numeric not null,
  note text,
  created_at timestamptz default now()
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid,
  action_type text,
  details text,
  actor_name text,
  actor_role text,
  actor_id uuid,
  metadata jsonb
);
create table public.profiles (id uuid primary key, role text);
insert into public.profiles (id, role) values ('00000000-0000-0000-0000-000000000099', 'ADMIN');
create or replace function public.customer_excess_credit(uuid) returns numeric
language sql stable as $$ select coalesce(sum(amount), 0) from public.customer_credit_ledger where customer_id = $1 $$;
create function public.record_excess_credit(uuid, uuid, numeric, text) returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.apply_service_downpayment(uuid, uuid, numeric) returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.settle_overpayment_on_completion(uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
`;

const run = async () => {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(migration);
  const clientCreditWrite = await db.query(`
    select has_function_privilege('authenticated', 'public.record_excess_credit(uuid,uuid,numeric,text)', 'EXECUTE') as allowed
  `);
  assert.equal(clientCreditWrite.rows[0].allowed, false);
  const clientCreditAbsorb = await db.query(`
    select has_function_privilege('authenticated', 'public.apply_service_downpayment(uuid,uuid,numeric)', 'EXECUTE') as allowed
  `);
  assert.equal(clientCreditAbsorb.rows[0].allowed, false);
  const customerId = '00000000-0000-0000-0000-000000000001';
  const bookingIds = {
    underpaid: '00000000-0000-0000-0000-000000000011',
    oldEntry: '00000000-0000-0000-0000-000000000012',
    overpaid: '00000000-0000-0000-0000-000000000013',
    unrelated: '00000000-0000-0000-0000-000000000014',
  };

  await db.query(`
    insert into public.bookings (id, customer_id, total_amount, status) values
      ($1, $2, 2300, 'scheduled'),
      ($3, $2, 2300, 'scheduled'),
      ($4, $2, 1000, 'scheduled'),
      ($5, $2, 500, 'scheduled')
  `, [bookingIds.underpaid, customerId, bookingIds.oldEntry, bookingIds.overpaid, bookingIds.unrelated]);

  await db.query(`insert into public.payments (booking_id, amount, method, status) values ($1, 1500, 'GCash', 'PAID')`, [bookingIds.underpaid]);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.underpaid])).rows[0].credit), 0);

  await db.query(`update public.bookings set total_amount = 2800 where id = $1`, [bookingIds.underpaid]);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.underpaid])).rows[0].credit), 0);
  await db.query(`insert into public.payments (booking_id, amount, method, status) values ($1, 1000, 'Cash', 'PENDING')`, [bookingIds.underpaid]);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.underpaid])).rows[0].credit), 0);

  await db.query(`insert into public.payments (booking_id, amount, method, status) values ($1, 1500, 'GCash', 'FOR_VERIFICATION')`, [bookingIds.oldEntry]);
  await db.query(`insert into public.customer_credit_ledger (customer_id, booking_id, entry_type, amount, balance_after, note) values ($1, $2, 'EXCESS', 350, 350, 'historic premature credit')`, [customerId, bookingIds.oldEntry]);
  await db.query(`select public.reconcile_booking_excess_credit($1)`, [bookingIds.oldEntry]);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.oldEntry])).rows[0].credit), 0);

  await db.query(`insert into public.payments (booking_id, amount, method, status) values ($1, 1500, 'GCash', 'PAID')`, [bookingIds.overpaid]);
  await db.query(`insert into public.payments (booking_id, amount, method, status) values ($1, 600, 'Cash', 'PAID')`, [bookingIds.unrelated]);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.overpaid])).rows[0].credit), 500);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.unrelated])).rows[0].credit), 100);

  await db.query(`update public.bookings set total_amount = 1400 where id = $1`, [bookingIds.overpaid]);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.overpaid])).rows[0].credit), 100);

  await db.query(`update public.bookings set status = 'completed' where id = $1`, [bookingIds.overpaid]);
  const settled = await db.query(`select public.settle_overpayment_on_completion($1) as result`, [bookingIds.overpaid]);
  assert.equal(Number(settled.rows[0].result.routed), 100);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.overpaid])).rows[0].credit), 0);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.unrelated])).rows[0].credit), 100);
  assert.equal((await db.query(`select status from public.bookings where id = $1`, [bookingIds.overpaid])).rows[0].status, 'completed');

  const partialRefund = await db.query(`
    select public.process_overpayment_credit_refund(
      $1, 40, 'Partial unused booking overpayment', 'RFD-TEST-1', '00000000-0000-0000-0000-000000000099'
    ) as result
  `, [bookingIds.overpaid]);
  assert.equal(Number(partialRefund.rows[0].result.refund_amount), 40);
  assert.equal((await db.query(`select status from public.bookings where id = $1`, [bookingIds.overpaid])).rows[0].status, 'completed');
  assert.equal((await db.query(`select refund_status from public.bookings where id = $1`, [bookingIds.overpaid])).rows[0].refund_status, 'QUEUED');

  const finalRefund = await db.query(`
    select public.process_overpayment_credit_refund(
      $1, 60, 'Remaining unused booking overpayment', 'RFD-TEST-2', '00000000-0000-0000-0000-000000000099'
    ) as result
  `, [bookingIds.overpaid]);
  assert.equal(Number(finalRefund.rows[0].result.refund_amount), 60);
  assert.equal((await db.query(`select refund_status from public.bookings where id = $1`, [bookingIds.overpaid])).rows[0].refund_status, 'PROCESSED');
  assert.equal(Number((await db.query(`select sum(amount) as amount from public.payments where booking_id = $1 and method = 'SYSTEM_REFUND'`, [bookingIds.overpaid])).rows[0].amount), -100);

  let excessLimitRejected = false;
  try {
    await db.query(`
      select public.process_overpayment_credit_refund(
        $1, 1, 'Too much', 'RFD-TEST-3', '00000000-0000-0000-0000-000000000099'
      )
    `, [bookingIds.overpaid]);
  } catch (error) {
    excessLimitRejected = /queued excess/.test(error.message);
  }
  assert.equal(excessLimitRejected, true);

  await db.query(`update public.payments set status = 'PAID' where booking_id = $1 and status = 'FOR_VERIFICATION'`, [bookingIds.oldEntry]);
  assert.equal(Number((await db.query(`select public.customer_booking_excess_credit($1, $2) as credit`, [customerId, bookingIds.oldEntry])).rows[0].credit), 0);

  console.log('PASS  booking-scoped verified credit lifecycle and refund isolation');
  await db.close();
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});