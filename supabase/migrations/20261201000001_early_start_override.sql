-- Before photos (and so starting a service) open at the scheduled time. When the customer arrives early, the
-- assigned technician or an admin can allow an early start for that booking, on its scheduled day.

alter table public.bookings
  add column if not exists early_start_allowed_at timestamptz,
  add column if not exists early_start_allowed_by uuid references public.profiles(id) on delete set null;

-- The one rule for "may work on this booking start now": the time has come, or an early start was allowed.
create or replace function public.booking_start_time_reached(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bookings b
     where b.id = p_booking_id
       and (b.start_datetime <= now() or b.early_start_allowed_at is not null)
  );
$$;
revoke all on function public.booking_start_time_reached(uuid) from public, anon;
grant execute on function public.booking_start_time_reached(uuid) to authenticated, service_role;

-- The allowance can only be set through allow_early_start(), and it ends when the booking is moved to a later time.
create or replace function public.guard_early_start_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.start_datetime is distinct from old.start_datetime and new.start_datetime > now() then
      new.early_start_allowed_at := null;
      new.early_start_allowed_by := null;
    elsif (new.early_start_allowed_at is distinct from old.early_start_allowed_at
           or new.early_start_allowed_by is distinct from old.early_start_allowed_by)
          and auth.uid() is not null
          and coalesce(current_setting('comar.early_start', true), '') <> 'on' then
      raise exception 'An early start can only be allowed from the booking screen.' using errcode = '42501';
    end if;
  elsif new.early_start_allowed_at is not null and auth.uid() is not null then
    new.early_start_allowed_at := null;
    new.early_start_allowed_by := null;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_early_start_columns on public.bookings;
create trigger trg_guard_early_start_columns
  before insert or update on public.bookings
  for each row execute function public.guard_early_start_columns();

create or replace function public.allow_early_start(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_name text;
  b public.bookings%rowtype;
begin
  if v_uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select upper(coalesce(role::text, '')), coalesce(nullif(btrim(full_name), ''), email, 'User')
    into v_role, v_name from public.profiles where id = v_uid;

  select * into b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0002'; end if;

  if v_role is distinct from 'ADMIN'
     and not exists (select 1 from public.booking_vehicles v where v.booking_id = b.id and v.staff_id = v_uid) then
    raise exception 'Only an admin or the assigned technician can allow an early start.' using errcode = '42501';
  end if;
  if lower(coalesce(b.status::text, '')) not in ('scheduled', 'confirmed') then
    raise exception 'An early start is only for a booking that is waiting to start.' using errcode = '23514';
  end if;
  if (b.start_datetime at time zone 'Asia/Manila')::date <> (now() at time zone 'Asia/Manila')::date then
    raise exception 'An early start is only possible on the booking''s scheduled day.' using errcode = '23514';
  end if;
  if b.start_datetime <= now() then
    return jsonb_build_object('allowed', true, 'already_open', true);
  end if;
  if b.early_start_allowed_at is not null then
    return jsonb_build_object('allowed', true, 'already_open', false, 'at', b.early_start_allowed_at);
  end if;

  perform set_config('comar.early_start', 'on', true);
  update public.bookings set early_start_allowed_at = now(), early_start_allowed_by = v_uid where id = b.id;

  insert into public.audit_logs (booking_id, action_type, details, actor_name, actor_role, actor_id, metadata, created_at)
  values (b.id, 'EARLY_START_ALLOWED',
          format('%s allowed service to start before the scheduled time (booking #%s).', v_name, left(b.id::text, 8)),
          v_name, coalesce(nullif(v_role, ''), 'USER'), v_uid,
          jsonb_build_object('scheduled_for', b.start_datetime), now());

  return jsonb_build_object('allowed', true, 'already_open', false, 'at', now());
end;
$$;
revoke all on function public.allow_early_start(uuid) from public, anon;
grant execute on function public.allow_early_start(uuid) to authenticated;

-- A technician can add the before photo only once the scheduled time has come (or an early start was allowed).
drop policy if exists service_photos_insert_staff_admin on public.service_photos;
create policy service_photos_insert_staff_admin on public.service_photos
  for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = (select auth.uid()) and upper(p.role) = 'ADMIN')
    or (
      public.staff_booking_has_verified_downpayment(booking_id)
      and exists (
        select 1
          from public.bookings b
          join public.booking_vehicles v on v.booking_id = b.id
         where b.id = service_photos.booking_id
           and v.staff_id = (select auth.uid())
           and v.id = service_photos.booking_vehicle_id
           and (
             (service_photos.phase = 'before' and upper(v.status) = any (array['PENDING', 'SCHEDULED', 'CONFIRMED'])
               and public.booking_start_time_reached(b.id))
             or (service_photos.phase = 'after' and upper(v.status) = 'IN_PROGRESS')
           )
      )
      and not public.vehicle_has_photo_phase(booking_vehicle_id, phase)
    )
  );
