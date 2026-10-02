-- A staff member submits each vehicle's before/after evidence once. Allow a
-- multi-photo initial submission, then prevent additional staff inserts for
-- that vehicle and phase. Admins retain their evidence-management access.

drop policy if exists "service_photos_insert_staff_admin" on public.service_photos;
create policy "service_photos_insert_staff_admin"
  on public.service_photos
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.profiles p
       where p.id = auth.uid()
         and upper(p.role) = 'ADMIN'
    )
    or (
      (
        exists (
          select 1
            from public.bookings b
           where b.id = service_photos.booking_id
             and b.staff_id = auth.uid()
        )
        or exists (
          select 1
            from public.profiles p
           where p.id = auth.uid()
             and upper(p.role) = 'STAFF'
        )
      )
      and not public.vehicle_has_photo_phase(
        service_photos.booking_vehicle_id,
        service_photos.phase
      )
    )
  );

drop policy if exists "service_proofs_insert_scoped" on storage.objects;
create policy "service_proofs_insert_scoped"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'service-proofs'
    and (
      exists (
        select 1
          from public.profiles p
         where p.id = auth.uid()
           and upper(p.role) = 'ADMIN'
      )
      or (
        (
          exists (
            select 1
              from public.bookings b
             where b.id::text = (storage.foldername(name))[1]
               and b.staff_id = auth.uid()
          )
          or exists (
            select 1
              from public.profiles p
             where p.id = auth.uid()
               and upper(p.role) = 'STAFF'
          )
        )
        and (storage.foldername(name))[3] in ('before', 'after')
        and not public.vehicle_has_photo_phase(
          (storage.foldername(name))[2]::uuid,
          (storage.foldername(name))[3]
        )
      )
    )
  );
