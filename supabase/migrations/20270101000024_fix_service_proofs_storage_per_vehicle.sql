-- service_proofs_insert_scoped still checked the booking-level lead technician (b.staff_id),
-- but per-vehicle technician assignment means a non-lead tech's vehicle can have a different
-- staff_id. That tech's photo upload was rejected by storage RLS before the DB insert even ran,
-- blocking them from ever starting/finishing their assigned vehicle. Match the fix already
-- applied to the table-level policy (service_photos_insert_staff_admin): check v.staff_id.
drop policy if exists "service_proofs_insert_scoped" on storage.objects;
create policy "service_proofs_insert_scoped"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'service-proofs'
    and (
      exists (
        select 1 from public.profiles p
         where p.id = auth.uid() and upper(p.role) = 'ADMIN'
      )
      or (
        (storage.foldername(name))[3] in ('before', 'after')
        and public.staff_booking_has_verified_downpayment(
          (storage.foldername(name))[1]::uuid
        )
        and exists (
          select 1
            from public.bookings b
            join public.booking_vehicles v
              on v.booking_id = b.id
           where b.id::text = (storage.foldername(name))[1]
             and v.staff_id = auth.uid()
             and v.id::text = (storage.foldername(name))[2]
             and (
               ((storage.foldername(name))[3] = 'before'
                 and upper(v.status::text) in ('PENDING', 'SCHEDULED', 'CONFIRMED'))
               or ((storage.foldername(name))[3] = 'after'
                 and upper(v.status::text) = 'IN_PROGRESS')
             )
             and not public.vehicle_has_photo_phase(
               v.id,
               (storage.foldername(name))[3]
             )
        )
      )
    )
  );
