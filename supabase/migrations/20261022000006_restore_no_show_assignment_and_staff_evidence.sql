-- Keep the original staff assignment while a no-show is quarantined so an
-- explicit admin undo can restore the correct technician.
alter table public.bookings
  add column if not exists no_show_staff_id uuid;

create or replace function public.preserve_no_show_assignment()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if upper(coalesce(new.status, '')) in ('FLAGGED_NOSHOW', 'NO_SHOW')
     and upper(coalesce(old.status, '')) not in ('FLAGGED_NOSHOW', 'NO_SHOW') then
    new.no_show_staff_id := coalesce(new.no_show_staff_id, old.staff_id);
  elsif upper(coalesce(old.status, '')) in ('FLAGGED_NOSHOW', 'NO_SHOW')
        and upper(coalesce(new.status, '')) in ('SCHEDULED', 'CONFIRMED') then
    new.staff_id := coalesce(new.no_show_staff_id, new.staff_id);
    new.no_show_staff_id := null;
  elsif upper(coalesce(old.status, '')) in ('FLAGGED_NOSHOW', 'NO_SHOW')
        and upper(coalesce(new.status, '')) = 'CANCELLED' then
    new.no_show_staff_id := null;
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_preserve_no_show_assignment on public.bookings;
create trigger bookings_preserve_no_show_assignment
  before update of status on public.bookings
  for each row
  execute function public.preserve_no_show_assignment();

-- Staff retain read access to evidence they personally submitted, even after
-- an admin release or reassignment removes the current bookings.staff_id link.
drop policy if exists "service_photos_select_owner_staff_admin" on public.service_photos;
create policy "service_photos_select_owner_staff_admin"
  on public.service_photos
  for select
  to authenticated
  using (
    uploaded_by = auth.uid()
    or exists (
      select 1
        from public.bookings b
       where b.id = service_photos.booking_id
         and (
           b.customer_id = auth.uid()
           or b.staff_id = auth.uid()
         )
    )
    or exists (
      select 1
        from public.profiles p
       where p.id = auth.uid()
         and upper(p.role) = 'ADMIN'
    )
  );

drop policy if exists "service_proofs_read_scoped" on storage.objects;
create policy "service_proofs_read_scoped"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'service-proofs'
    and (
      exists (
        select 1
          from public.service_photos sp
         where sp.storage_path = storage.objects.name
           and sp.uploaded_by = auth.uid()
           and sp.archived_at is null
      )
      or exists (
        select 1
          from public.bookings b
         where b.id::text = (storage.foldername(name))[1]
           and (
             b.customer_id = auth.uid()
             or b.staff_id = auth.uid()
           )
      )
      or exists (
        select 1
          from public.profiles p
         where p.id = auth.uid()
           and upper(p.role) = 'ADMIN'
      )
    )
  );
