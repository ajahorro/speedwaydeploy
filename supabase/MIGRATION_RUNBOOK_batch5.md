# Batch 5 — Live Migration Runbook

Applies the three Batch 5 migrations to the live Supabase project.

**Project ref:** `nsmytxlaidmndtqxctrw`
**Migrations (in order):**

| # | File | What it does |
|---|------|--------------|
| 1 | `20260924000001_add_service_photos_table.sql` | `service_photos` table + RLS + indexes + idempotent legacy backfill |
| 2 | `20260924000002_create_service_proofs_private_bucket.sql` | Private `service-proofs` bucket + storage RLS policies |
| 3 | `20260924000003_add_photo_retention_policy.sql` | Retention config + archive/purge functions + `pg_cron` daily job |

> ⚠️ **Do not run these against a scratch database and call it done** — the project is the one above. Run against **production** only when ready.
> All three are **idempotent** (`if not exists` / `drop policy if exists` / guarded `DO` blocks), so a re-run is safe.

---

## Prerequisites

- Supabase CLI **v2.x** (verified locally: `2.117.0`)
- The **database password** for project `nsmytxlaidmndtqxctrw`
- **`pg_cron` must be enabled** for migration 3's scheduler. On Supabase it is a built-in extension; migration 3 enables it defensively (if it can't, it warns instead of failing and you schedule the job manually — see *Option C*).

> The full DB connection string looks like:
> `postgresql://postgres.<REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres`
> (Region is shown in Supabase Dashboard → Project Settings → Database → Connection string.)

---

## Option A — Supabase CLI (recommended, tracks migration history)

The repo has `supabase/migrations/*.sql` but **no `supabase/config.toml`**, so link first.

```powershell
cd C:\Users\ajaho\Downloads\speedway_thesis

# 1. Authenticate the CLI (opens a browser / asks for an access token)
npx supabase login

# 2. Link this folder to the live project (creates supabase/config.toml)
npx supabase link --project-ref nsmytxlaidmndtqxctrw
#    -> when prompted, paste the DB password

# 3. Inspect what WILL be applied, without applying it
npx supabase migration list

# 4. Apply pending migrations (the 3 new ones)
npx supabase db push
#    -> confirms the list, then applies. Answer Y.

# 5. Verify history now includes the three Batch 5 migrations
npx supabase migration list
```

Expected new rows in the remote column:
```
20260924000001 | 20260924000001_add_service_photos_table
20260924000002 | 20260924000002_create_service_proofs_private_bucket
20260924000003 | 20260924000003_add_photo_retention_policy
```

---

## Option B — Direct `psql` (no CLI linking)

Useful if you can't run `supabase login`, or want per-file control.

```powershell
# Set once (PowerShell). Replace <DB_PASSWORD> and <REGION>.
$env:PGPASSWORD = "<DB_PASSWORD>"
$DB = "postgresql://postgres.nsmytxlaidmndtqxctrw:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres"

# Apply in order. -v ON_ERROR_STOP=1 stops on the first error so a failure is visible.
psql $DB -v ON_ERROR_STOP=1 -f supabase/migrations/20260924000001_add_service_photos_table.sql
psql $DB -v ON_ERROR_STOP=1 -f supabase/migrations/20260924000002_create_service_proofs_private_bucket.sql
psql $DB -v ON_ERROR_STOP=1 -f supabase/migrations/20260924000003_add_photo_retention_policy.sql
```

> If you use Option B, the Supabase **CLI migration history is not updated**. Record the three versions manually so a future `db push` does not try to re-apply them:
> ```sql
> insert into supabase_migrations.schema_migrations (version, name) values
>   ('20260924000001', 'add_service_photos_table'),
>   ('20260924000002', 'create_service_proofs_private_bucket'),
>   ('20260924000003', 'add_photo_retention_policy')
> on conflict do nothing;
> ```

---

## Option C — Dashboard SQL Editor (quickest, manual history)

1. Open **Supabase Dashboard → SQL Editor** for `nsmytxlaidmndtqxctrw`.
2. Paste and run each file **in order** (contents of the three files above).
3. Register the versions in `supabase_migrations.schema_migrations` as in Option B.

If migration 3 warns "pg_cron not present", enable it and schedule manually:
```sql
-- Enable the scheduler (Dashboard → Database → Extensions → pg_cron also works)
create extension if not exists pg_cron;

-- Daily at 03:15 UTC
select cron.schedule(
  'service_photos_retention',
  '15 3 * * *',
  'select public.run_service_photo_retention();'
);
```

---

## Post-apply verification (run these; each should return the expected result)

```sql
-- 1. Table exists with the phase check constraint
select count(*) from information_schema.tables where table_name = 'service_photos';      -- 1

-- 2. Private bucket, 10 MB limit
select id, public, file_size_limit from storage.buckets where id = 'service-proofs';     -- public = false

-- 3. RLS enabled + 4 policies
select relrowsecurity from pg_class where relname = 'service_photos';                    -- true
select count(*) from pg_policies where tablename = 'service_photos';                     -- 4

-- 4. Retention config defaults
select photo_retention_archive_months, photo_retention_purge_months from business_config; -- 12, 24

-- 5. Functions present
select proname from pg_proc where proname in
  ('archive_stale_service_photos','purge_stale_service_photos','run_service_photo_retention'); -- 3 rows

-- 6. Legacy backfill produced rows (only if there were historic photo_proof_url values)
select phase, source, count(*) from service_photos group by phase, source;

-- 7. Cron job scheduled (only if pg_cron is present)
select jobname, schedule, command from cron.job where jobname = 'service_photos_retention';
```

### Storage policy sanity check (run in the app or via SQL as a non-admin)
- A **staff** user assigned to a booking can `createSignedUrl` for that booking's objects.
- A **customer** cannot read photos from **another** customer's booking (RLS blocks it).
- An **admin** can read all.

---

## Rollback (only if you must undo Batch 5)

```sql
-- Remove the scheduled job first so it can't fire mid-rollback.
select cron.unschedule('service_photos_retention');

drop table if exists public.service_photos cascade;
drop function if exists public.run_service_photo_retention();
drop function if exists public.archive_stale_service_photos();
drop function if exists public.purge_stale_service_photos();

alter table public.business_config
  drop column if exists photo_retention_archive_months,
  drop column if exists photo_retention_purge_months;

-- Storage policies + bucket
drop policy if exists "service_proofs_read_scoped" on storage.objects;
drop policy if exists "service_proofs_insert_scoped" on storage.objects;
drop policy if exists "service_proofs_update_admin" on storage.objects;
drop policy if exists "service_proofs_delete_admin" on storage.objects;
delete from storage.buckets where id = 'service-proofs';
```

> ⚠️ The rollback does **not** delete objects already stored in the `service-proofs` bucket. Empty the bucket from the Dashboard (Storage → service-proofs) if you need a clean slate.

---

## After applying — tell me and I'll run the Master E2E Browser Sweep

The live interaction tests (upload photo, hit the completion gate, open the evidence drawer) need:
1. These migrations applied, and
2. A booking assigned to a staff account (`staff1@speedway.com` had an empty queue).

Once #1 is done, run this and share the output with me — or I can drive it:

```powershell
cd C:\Users\ajaho\Downloads\speedway_thesis\frontend
npm run dev   # :5173
```
```powershell
# in another shell
node "C:\Users\ajaho\.codegpt\skills\browser-automation\browser.mjs" http://localhost:5173/ --script ./scratch/e2e_master.mjs
```
