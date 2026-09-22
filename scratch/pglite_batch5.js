// Batch 5: execute the migration SQL against a real Postgres (PGlite/WASM).
//
// Bare Postgres lacks the Supabase objects the migrations reference
// (auth.uid(), storage.buckets, cron, net, the app tables). We create minimal
// shims for exactly those, then run the three migrations verbatim. This is a
// genuine parse + semantics check: any syntax error, bad column reference, or
// invalid policy predicate will throw here.
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const dir = path.resolve(__dirname, '../supabase/migrations');
const files = [
  '20260924000001_add_service_photos_table.sql',
  '20260924000002_create_service_proofs_private_bucket.sql',
  '20260924000003_add_photo_retention_policy.sql'
];

// Minimal shims mirroring the real Supabase surface the SQL touches.
const SHIMS = `
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists cron;
create schema if not exists net;

create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

-- Enums / roles used by policies.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

-- app tables the migrations read.
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  role text,
  full_name text
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.profiles(id),
  staff_id uuid references public.profiles(id),
  status text,
  created_at timestamptz default now()
);

create table if not exists public.booking_vehicles (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete cascade,
  status text,
  photo_proof_url text,
  service_notes text,
  updated_at timestamptz default now()
);

create table if not exists public.business_config (
  id int primary key default 1,
  promo_rules jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);
insert into public.business_config (id) values (1) on conflict do nothing;

-- storage surface.
create table if not exists storage.buckets (
  id text primary key,
  name text,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select string_to_array(name, '/') $$;

-- pg_net + pg_cron surface (no-ops).
create table if not exists net.http_request_queue (id bigserial primary key);
create or replace function net.http_post(url text, headers jsonb, body jsonb)
  returns bigint language sql as $$ select 1::bigint $$;

create table if not exists cron.job (jobid bigint primary key, jobname text, schedule text, command text);
create sequence if not exists cron.jobid_seq start 1;
create or replace function cron.schedule(job_name text, sched text, cmd text)
  returns bigint language plpgsql as $$
  declare v_id bigint; begin
    insert into cron.job (jobid, jobname, schedule, command)
    values (nextval('cron.jobid_seq'), job_name, sched, cmd) returning jobid into v_id;
    return v_id;
  end $$;
create or replace function cron.unschedule(job_id bigint)
  returns boolean language plpgsql as $$
  begin delete from cron.job where jobid = job_id; return true; end $$;

-- Seed a legacy photo row to exercise the backfill path.
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'ADMIN'),
  ('00000000-0000-0000-0000-0000000000b1', 'STAFF'),
  ('00000000-0000-0000-0000-0000000000c1', 'CUSTOMER');
insert into public.bookings (id, customer_id, staff_id, status)
  values ('00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000b1', 'completed');
insert into public.booking_vehicles (id, booking_id, photo_proof_url)
  values ('00000000-0000-0000-0000-0000000000e1',
          '00000000-0000-0000-0000-0000000000d1',
          '["https://old.example.com/a.jpg","https://old.example.com/b.jpg"]');
`;

(async () => {
  const db = new PGlite();
  try {
    await db.exec(SHIMS);
    console.log('-- shims applied --');

    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        await db.exec(sql);
        console.log(`PASS  ${f} (parsed + executed)`);
      } catch (e) {
        console.log(`FAIL  ${f}\n        ${e.message}`);
        process.exitCode = 1;
      }
    }

    // Assertions proving the schema + logic actually work.
    const asserts = [];
    const q = async (sql) => (await db.query(sql)).rows;

    asserts.push(['service_photos table exists',
      (await q(`select count(*)::int as n from information_schema.tables where table_name='service_photos'`))[0].n === 1]);

    const backfilled = await q(`select phase, source, storage_path from public.service_photos order by storage_path`);
    asserts.push(['legacy backfill produced 2 after-photos',
      backfilled.length === 2 && backfilled.every(r => r.phase === 'after' && r.source === 'legacy_backfill')]);

    // Idempotent re-run of migration 1 must not duplicate backfill rows.
    await db.exec(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    const afterRerun = await q(`select count(*)::int as n from public.service_photos`);
    asserts.push(['migration 1 re-run is idempotent (still 2 rows)', afterRerun[0].n === 2]);

    const bucket = await q(`select public, file_size_limit from storage.buckets where id='service-proofs'`);
    asserts.push(['service-proofs bucket is private',
      bucket.length === 1 && bucket[0].public === false && Number(bucket[0].file_size_limit) === 10485760]);

    const pol = await q(`select count(*)::int as n from pg_policies where tablename='service_photos'`);
    asserts.push(['service_photos has 4 RLS policies', pol[0].n === 4]);

    const cfg = await q(`select photo_retention_archive_months as a, photo_retention_purge_months as p from public.business_config`);
    asserts.push(['retention config defaults 12/24', cfg[0].a === 12 && cfg[0].p === 24]);

    // Archive logic: insert an old unarchived row -> should be archived, not purged.
    await db.exec(`insert into public.service_photos (booking_id, phase, storage_path, uploaded_at)
      values ('00000000-0000-0000-0000-0000000000d1','after','old/x.jpg', now() - interval '13 months')`);
    const archivedCount = (await q(`select public.archive_stale_service_photos() as n`))[0].n;
    asserts.push(['archive_stale_service_photos archives 1 old row', archivedCount === 1]);

    // Purge logic: a 25-month-old archived row -> purged, path returned.
    await db.exec(`insert into public.service_photos (booking_id, phase, storage_path, uploaded_at, archived_at)
      values ('00000000-0000-0000-0000-0000000000d1','after','ancient/y.jpg', now() - interval '25 months', now() - interval '13 months')`);
    const purged = await q(`select storage_path from public.purge_stale_service_photos()`);
    asserts.push(['purge_stale_service_photos removes the ancient row',
      purged.length === 1 && purged[0].storage_path === 'ancient/y.jpg']);

    // Legal hold: exempt row is never touched by archive or purge.
    await db.exec(`insert into public.service_photos (booking_id, phase, storage_path, uploaded_at, retention_exempt)
      values ('00000000-0000-0000-0000-0000000000d1','after','hold/z.jpg', now() - interval '40 months', true)`);
    await q(`select public.archive_stale_service_photos()`);
    await q(`select public.purge_stale_service_photos()`);
    const held = await q(`select count(*)::int as n from public.service_photos where storage_path='hold/z.jpg'`);
    asserts.push(['retention_exempt legal hold survives archive+purge', held[0].n === 1]);

    // Cron job registered.
    const job = await q(`select jobname, command from cron.job where jobname='service_photos_retention'`);
    asserts.push(['cron job service_photos_retention scheduled',
      job.length === 1 && job[0].command.includes('run_service_photo_retention')]);

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
