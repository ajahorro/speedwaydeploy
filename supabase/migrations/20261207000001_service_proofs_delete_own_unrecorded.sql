-- A technician can clear a photo file they uploaded themselves while no photo record uses it.
--
-- Uploading a service photo stores the file first and records it second. If the second step fails (a lost connection,
-- or a phone clock that unlocks the picker a little early), the page tries to remove the file it just stored. Only
-- administrators could delete files, so that clean-up silently failed and the file stayed in storage with no record.
--
-- This rule allows exactly that clean-up and nothing more: the person who stored the file, while no photo record points
-- at it. Once a photo is recorded it can only be removed by an administrator or by the retention routine.

drop policy if exists "service_proofs_delete_own_unrecorded" on storage.objects;
create policy "service_proofs_delete_own_unrecorded"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'service-proofs'
    and owner_id = (select auth.uid())::text
    and not exists (
      select 1
        from public.service_photos sp
       where sp.storage_path = storage.objects.name
    )
  );
