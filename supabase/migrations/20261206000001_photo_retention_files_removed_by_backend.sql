-- Service photo retention, second phase: the stored files must go together with their records.
--
-- Before: the nightly database job deleted the records of photos past the purge window and then asked an edge
-- function (purge-archived-photos) to delete the files. That function was never deployed, so the records were
-- removed and the files stayed in storage for good.
--
-- Now: the database job only archives (phase 1). The backend (backend/services/photoRetention.js) asks for the
-- records that are due, removes their stored files first and the records second, so a failed file removal leaves
-- the record in place and the next run tries again.

-- 1. The records that are past the purge window (archived, not on legal hold). Read-only.
create or replace function public.service_photos_due_for_purge(p_limit integer default 100)
returns table (id uuid, storage_path text)
language sql
stable
security definer
set search_path = public
as $$
  select sp.id, sp.storage_path
    from public.service_photos sp
   where sp.retention_exempt = false
     and sp.archived_at is not null
     and sp.uploaded_at < now() - make_interval(months => coalesce(
           (select bc.photo_retention_purge_months from public.business_config bc order by bc.id limit 1), 24))
   order by sp.uploaded_at
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
revoke all on function public.service_photos_due_for_purge(integer) from public, anon, authenticated;
grant execute on function public.service_photos_due_for_purge(integer) to service_role;

-- 2. The scheduled job archives only. It never deletes a record.
create or replace function public.run_service_photo_retention()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  return coalesce(public.archive_stale_service_photos(), 0);
end;
$$;

-- 3. The routine that deleted records without removing their files is gone.
drop function if exists public.purge_stale_service_photos();

comment on function public.service_photos_due_for_purge(integer) is
  'Phase 2 of photo retention: lists the records past the purge window. The backend removes their files, then the records.';
comment on function public.run_service_photo_retention() is
  'Phase 1 of photo retention (daily): archives records past the archive window. Files and records are purged by the backend.';
