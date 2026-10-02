create or replace function public.staff_booking_has_verified_downpayment(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.bookings b
      join public.profiles p
        on p.id = auth.uid()
       and upper(p.role) = 'STAFF'
     where b.id = p_booking_id
       and b.staff_id = auth.uid()
       and greatest(
         0,
         coalesce((
           select sum(pmt.amount)
             from public.payments pmt
            where pmt.booking_id = b.id
              and pmt.amount > 0
              and upper(coalesce(pmt.status::text, '')) = 'PAID'
              and upper(coalesce(pmt.method::text, '')) <> 'SYSTEM_REFUND'
         ), 0)
         - coalesce((
           select sum(abs(pmt.amount))
             from public.payments pmt
            where pmt.booking_id = b.id
              and pmt.amount < 0
              and (
                upper(coalesce(pmt.method::text, '')) = 'SYSTEM_REFUND'
                or upper(coalesce(pmt.status::text, '')) = 'REFUNDED'
              )
         ), 0)
       ) >= round(
         coalesce(b.total_amount, 0)
         * case when coalesce(b.total_amount, 0) >= 2000 then 0.5 else 0.3 end,
         2
       )
  );
$$;

revoke all on function public.staff_booking_has_verified_downpayment(uuid) from public;
grant execute on function public.staff_booking_has_verified_downpayment(uuid) to authenticated;

create or replace function public.enforce_service_photo_phase_limit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_photo_count integer;
begin
  if new.booking_vehicle_id is null or new.archived_at is not null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.booking_vehicle_id::text || ':' || new.phase, 0)
  );

  select count(*)::integer
    into v_photo_count
    from public.service_photos photo
   where photo.booking_vehicle_id = new.booking_vehicle_id
     and photo.phase = new.phase
     and photo.archived_at is null;

  if v_photo_count >= 10 then
    raise exception 'SERVICE_PHOTO_PHASE_LIMIT_REACHED'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists service_photos_enforce_phase_limit on public.service_photos;
create trigger service_photos_enforce_phase_limit
  before insert on public.service_photos
  for each row
  execute function public.enforce_service_photo_phase_limit();

create or replace function public.prevent_staff_reassignment_after_before_evidence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.staff_id is not null
     and old.staff_id is distinct from new.staff_id
     and lower(coalesce(old.status::text, '')) not in (
       'completed', 'released', 'cancelled', 'flagged_noshow', 'no_show'
     )
     and exists (
       select 1
         from public.service_photos photo
        where photo.booking_id = old.id
          and photo.phase = 'before'
          and photo.uploaded_by = old.staff_id
          and photo.archived_at is null
     )
  then
    raise exception 'STAFF_REASSIGNMENT_LOCKED_AFTER_BEFORE_PHOTO'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_lock_staff_after_before_evidence on public.bookings;
create trigger bookings_lock_staff_after_before_evidence
  before update of staff_id on public.bookings
  for each row
  execute function public.prevent_staff_reassignment_after_before_evidence();

drop policy if exists "service_photos_select_owner_staff_admin" on public.service_photos;
create policy "service_photos_select_owner_staff_admin"
  on public.service_photos
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.bookings b
       where b.id = service_photos.booking_id
         and b.customer_id = auth.uid()
    )
    or (
      exists (
        select 1
          from public.bookings b
         where b.id = service_photos.booking_id
           and b.staff_id = auth.uid()
      )
      and public.staff_booking_has_verified_downpayment(service_photos.booking_id)
    )
    or exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and upper(p.role) = 'ADMIN'
    )
  );

drop policy if exists "service_photos_insert_staff_admin" on public.service_photos;
create policy "service_photos_insert_staff_admin"
  on public.service_photos
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.profiles p
       where p.id = auth.uid() and upper(p.role) = 'ADMIN'
    )
    or (
      public.staff_booking_has_verified_downpayment(service_photos.booking_id)
      and exists (
        select 1
          from public.bookings b
          join public.booking_vehicles v
            on v.booking_id = b.id
         where b.id = service_photos.booking_id
           and b.staff_id = auth.uid()
           and v.id = service_photos.booking_vehicle_id
           and (
             (service_photos.phase = 'before'
               and upper(v.status::text) in ('PENDING', 'SCHEDULED', 'CONFIRMED'))
             or (service_photos.phase = 'after'
               and upper(v.status::text) = 'IN_PROGRESS')
           )
      )
      and not public.vehicle_has_photo_phase(
        service_photos.booking_vehicle_id,
        service_photos.phase
      )
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
          from public.bookings b
         where b.id::text = (storage.foldername(name))[1]
           and b.customer_id = auth.uid()
      )
      or (
        exists (
          select 1
            from public.bookings b
           where b.id::text = (storage.foldername(name))[1]
             and b.staff_id = auth.uid()
        )
        and public.staff_booking_has_verified_downpayment(
          (storage.foldername(name))[1]::uuid
        )
      )
      or exists (
        select 1 from public.profiles p
         where p.id = auth.uid() and upper(p.role) = 'ADMIN'
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
             and b.staff_id = auth.uid()
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
