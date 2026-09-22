-- ============================================================================
-- Batch 5 / Step 1 (3 of 3) — Retention policy: config + two-phase cron job
-- ============================================================================
--
-- Implements the approved two-phase retention policy for service photo evidence:
--
--   PHASE 1 (archive)  : at `photo_retention_archive_months` (default 12) the row
--                        is marked archived_at. It disappears from the active UI
--                        but stays fully retrievable by an admin.
--   PHASE 2 (purge)    : at `photo_retention_purge_months` (default 24) the row
--                        is deleted. Storage objects are removed by the
--                        `purge-archived-photos` edge function (SQL cannot delete
--                        storage objects), which the DB enqueues via pg_net.
--
--   LEGAL HOLD         : rows with retention_exempt = true are skipped by BOTH
--                        phases (e.g. an open dispute or warranty claim).
--
-- The windows are configurable on business_config so they are never hard-coded.
-- ============================================================================

-- ── 1. Configurable retention windows on business_config ────────────────────
alter table public.business_config
  add column if not exists photo_retention_archive_months int not null default 12;

alter table public.business_config
  add column if not exists photo_retention_purge_months int not null default 24;

-- Guard the config against nonsense values (archive must be < purge, both > 0).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'business_config_photo_retention_bounds'
  ) then
    alter table public.business_config
      add constraint business_config_photo_retention_bounds
      check (
        photo_retention_archive_months > 0
        and photo_retention_purge_months > photo_retention_archive_months
      );
  end if;
end $$;

-- ── 2. Archive helper (phase 1) ─────────────────────────────────────────────
-- Marks rows older than the archive window. Idempotent: only touches rows not
-- already archived and never touches legal-hold rows.
create or replace function public.archive_stale_service_photos()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_archive_months int;
  v_count int;
begin
  select coalesce(photo_retention_archive_months, 12)
    into v_archive_months
    from public.business_config
    order by id
    limit 1;

  v_archive_months := coalesce(v_archive_months, 12);

  update public.service_photos
     set archived_at = now()
   where archived_at is null
     and retention_exempt = false
     and uploaded_at < (now() - make_interval(months => v_archive_months));

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── 3. Purge helper (phase 2) ───────────────────────────────────────────────
-- Returns the set of storage_paths that are now eligible for hard deletion, then
-- deletes the DB rows. The edge function is responsible for removing the actual
-- storage objects; we hand it the paths via pg_net in the cron job below.
--
-- We do the DB delete here (so a re-run cannot double-process) and return the
-- deleted paths so the caller can enqueue storage cleanup.
create or replace function public.purge_stale_service_photos()
returns table (storage_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purge_months int;
begin
  select coalesce(photo_retention_purge_months, 24)
    into v_purge_months
    from public.business_config
    order by id
    limit 1;

  v_purge_months := coalesce(v_purge_months, 24);

  return query
  with doomed as (
    delete from public.service_photos
     where retention_exempt = false
       and archived_at is not null
       and uploaded_at < (now() - make_interval(months => v_purge_months))
    returning service_photos.storage_path
  )
  select d.storage_path from doomed d;
end;
$$;

-- ── 4. Enable pg_cron (best-effort) ──────────────────────────────────────
-- pg_cron is standard on Supabase but may be unavailable on other Postgres
-- deployments. Creating the extension inside a DO block means a restricted
-- environment logs a warning instead of aborting the whole migration (the
-- retention FUNCTIONS above still work and can be invoked by whatever scheduler
-- the environment provides).
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise warning 'pg_cron unavailable (%): retention functions created but not scheduled', sqlerrm;
  end;
end $$;

-- ── 5. Orchestrator: archive + purge + enqueue storage cleanup ───────────────
-- A single callable entry point so the cron job is one trivial statement and the
-- logic is independently testable. Returns the number of rows archived for
-- observability.
create or replace function public.run_service_photo_retention()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_archived int;
  v_paths text[];
  v_service_key text := current_setting('app.supabase_service_role_key', true);
  v_project_url text := 'https://nsmytxlaidmndtqxctrw.supabase.co';
begin
  -- Phase 1: archive stale rows.
  v_archived := public.archive_stale_service_photos();

  -- Phase 2: purge rows past the purge window and collect their object paths.
  select array_agg(storage_path)
    into v_paths
    from public.purge_stale_service_photos();

  -- Ask the edge function to delete the storage objects (SQL cannot reach
  -- storage.objects' underlying objects directly). Best-effort: if the config
  -- setting is absent we log and continue rather than failing the job.
  if v_paths is not null and array_length(v_paths, 1) > 0 then
    if v_service_key is not null and v_service_key <> '' then
      perform net.http_post(
        url := v_project_url || '/functions/v1/purge-archived-photos',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object('paths', to_jsonb(v_paths))
      );
    else
      raise warning 'run_service_photo_retention: app.supabase_service_role_key unset; storage purge enqueue skipped';
    end if;
  end if;

  return coalesce(v_archived, 0);
end;
$$;

-- ── 6. Schedule the retention sweep (daily @ 03:15 UTC, best-effort) ───────
-- cron.schedule is not idempotent by name, so unschedule any prior job first.
-- Wrapped defensively: if pg_cron is unavailable here, skip scheduling rather
-- than failing the migration (the functions remain callable manually).
do $$
declare
  v_jobid bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     or exists (select 1 from pg_namespace where nspname = 'cron') then
    for v_jobid in select jobid from cron.job where jobname = 'service_photos_retention'
    loop
      perform cron.unschedule(v_jobid);
    end loop;

    perform cron.schedule(
      'service_photos_retention',
      '15 3 * * *',
      'select public.run_service_photo_retention();'
    );
  else
    raise warning 'pg_cron not present: service photo retention job NOT scheduled; call public.run_service_photo_retention() from your scheduler of choice.';
  end if;
exception when others then
  raise warning 'service photo retention scheduling skipped: %', sqlerrm;
end $$;

-- ── 7. Documentation ────────────────────────────────────────────────────────
comment on column public.business_config.photo_retention_archive_months is
  'Months after upload before service photos are archived (hidden from active UI, admin-retrievable). Default 12.';
comment on column public.business_config.photo_retention_purge_months is
  'Months after upload before archived service photos are hard-deleted (DB row + storage object). Default 24. Must exceed the archive window.';
comment on function public.archive_stale_service_photos() is
  'Phase 1 of photo retention: marks rows past the archive window. Skips retention_exempt legal holds.';
comment on function public.purge_stale_service_photos() is
  'Phase 2 of photo retention: deletes rows past the purge window and returns their storage_paths for object cleanup by the purge-archived-photos edge function.';
comment on function public.run_service_photo_retention() is
  'Batch 5 retention orchestrator invoked daily by pg_cron: archives, purges, and enqueues private-bucket object cleanup via pg_net.';
