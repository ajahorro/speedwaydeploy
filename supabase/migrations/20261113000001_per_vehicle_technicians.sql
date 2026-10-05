-- ============================================================================
-- A technician for each vehicle.
--
-- Until now a booking had ONE technician (bookings.staff_id). A booking with several vehicles can now
-- have a different technician on each. The rule:
--
--   booking_vehicles.staff_id  = the technician of that vehicle (the single source of truth; a vehicle
--                                with none is unassigned);
--   bookings.staff_id          = the "lead": kept in step automatically (the technician of the first
--                                assigned vehicle) so every older consumer keeps working. Setting the
--                                booking's technician directly assigns ALL its vehicles to that person
--                                (what the old single dropdown did); clearing it clears them all.
--
-- Everything that asked "is this staff member on this booking / vehicle" now asks per vehicle: what
-- staff can see and photograph, the workload limit, the lock after a before photo, notes, the
-- downpayment gate for photos, and "has active services" (protects against deactivating a technician
-- who still has work).
-- ============================================================================

-- 1. existing bookings: every vehicle carries its booking's technician
update public.booking_vehicles bv
   set staff_id = b.staff_id
  from public.bookings b
 where b.id = bv.booking_id and bv.staff_id is null and b.staff_id is not null;

-- 2. helpers (security definer so row-level-security policies can use them without recursing)
create or replace function public.vehicle_technician(p_vehicle_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select bv.staff_id from public.booking_vehicles bv where bv.id = p_vehicle_id;
$$;

create or replace function public.staff_on_booking(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.bookings b where b.id = p_booking_id and b.staff_id = auth.uid())
      or exists (select 1 from public.booking_vehicles bv where bv.booking_id = p_booking_id and bv.staff_id = auth.uid());
$$;

-- may the signed-in staff member see the photos of this vehicle (or, with no vehicle, of the booking)?
create or replace function public.staff_can_see_photo(p_booking_id uuid, p_vehicle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_vehicle_id is not null then public.vehicle_technician(p_vehicle_id) = auth.uid()
    else exists (select 1 from public.bookings b where b.id = p_booking_id and b.staff_id = auth.uid())
  end;
$$;
revoke all on function public.vehicle_technician(uuid), public.staff_on_booking(uuid), public.staff_can_see_photo(uuid, uuid) from public, anon;
grant execute on function public.vehicle_technician(uuid), public.staff_on_booking(uuid), public.staff_can_see_photo(uuid, uuid) to authenticated, service_role;

-- 3. keeping the booking's lead and its vehicles in step
create or replace function public.booking_vehicle_inherit_technician()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.staff_id is null then
    select b.staff_id into new.staff_id from public.bookings b where b.id = new.booking_id;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_booking_vehicle_inherit_technician on public.booking_vehicles;
create trigger trg_booking_vehicle_inherit_technician
  before insert on public.booking_vehicles
  for each row execute function public.booking_vehicle_inherit_technician();

-- booking-level technician changed -> every vehicle follows (not when the change came from a vehicle)
create or replace function public.booking_technician_to_vehicles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  update public.booking_vehicles
     set staff_id = new.staff_id
   where booking_id = new.id and staff_id is distinct from new.staff_id;
  return null;
end;
$$;
drop trigger if exists trg_booking_technician_to_vehicles on public.bookings;
create trigger trg_booking_technician_to_vehicles
  after update of staff_id on public.bookings
  for each row when (old.staff_id is distinct from new.staff_id)
  execute function public.booking_technician_to_vehicles();

-- vehicle technician changed -> the booking's lead follows (the first assigned vehicle)
create or replace function public.vehicle_technician_to_booking_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead uuid;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  select bv.staff_id into v_lead
    from public.booking_vehicles bv
   where bv.booking_id = new.booking_id and bv.staff_id is not null
   order by bv.created_at, bv.id
   limit 1;
  update public.bookings set staff_id = v_lead where id = new.booking_id and staff_id is distinct from v_lead;
  return null;
end;
$$;
drop trigger if exists trg_vehicle_technician_to_booking_lead on public.booking_vehicles;
create trigger trg_vehicle_technician_to_booking_lead
  after update of staff_id on public.booking_vehicles
  for each row when (old.staff_id is distinct from new.staff_id)
  execute function public.vehicle_technician_to_booking_lead();

-- 4. workload: counted per vehicle, against the limit the admin sets in the Business Hub
create or replace function public.enforce_vehicle_workload_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_others integer;
begin
  if new.staff_id is null or (tg_op = 'UPDATE' and new.staff_id is not distinct from old.staff_id) then
    return new;
  end if;
  select coalesce(max_vehicles_per_staff, 3) into v_limit from public.business_config order by id limit 1;
  v_limit := coalesce(v_limit, 3);
  select count(*) into v_others
    from public.booking_vehicles bv
    join public.bookings b on b.id = bv.booking_id
   where bv.staff_id = new.staff_id
     and bv.id is distinct from new.id
     and lower(coalesce(b.status, '')) in ('pending', 'confirmed', 'in_progress', 'ongoing', 'scheduled');
  if v_others + 1 > v_limit then
    raise exception 'Workload limit exceeded: Technician cannot handle more than % active units. Current: %, Adding: 1', v_limit, v_others
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_enforce_vehicle_workload on public.booking_vehicles;
create trigger trg_enforce_vehicle_workload
  before insert or update of staff_id on public.booking_vehicles
  for each row execute function public.enforce_vehicle_workload_limit();
-- the booking-level check counted the same thing with a fixed limit of 3; the vehicle check replaces it
drop trigger if exists trg_enforce_staff_workload on public.bookings;

-- 5. a technician cannot be swapped off a vehicle after their before photo
create or replace function public.prevent_vehicle_reassignment_after_before_photo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.staff_id is not null and new.staff_id is distinct from old.staff_id
     and exists (
       select 1 from public.service_photos photo
        where photo.booking_vehicle_id = old.id and photo.phase = 'before'
          and photo.uploaded_by = old.staff_id and photo.archived_at is null)
     and exists (
       select 1 from public.bookings b
        where b.id = old.booking_id
          and lower(coalesce(b.status::text, '')) not in ('completed', 'released', 'cancelled', 'flagged_noshow', 'no_show'))
  then
    raise exception 'STAFF_REASSIGNMENT_LOCKED_AFTER_BEFORE_PHOTO' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_vehicle_lock_after_before_photo on public.booking_vehicles;
create trigger trg_vehicle_lock_after_before_photo
  before update of staff_id on public.booking_vehicles
  for each row execute function public.prevent_vehicle_reassignment_after_before_photo();

-- 6. audit: a change made on one vehicle is written to the booking's history
create or replace function public.audit_vehicle_staff_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text := 'System';
  v_actor_role text := 'SYSTEM';
  v_old text;
  v_new text;
  v_label text;
begin
  if pg_trigger_depth() > 1 or new.staff_id is not distinct from old.staff_id then return null; end if;
  if v_actor_id is not null then
    select coalesce(nullif(btrim(full_name), ''), nullif(btrim(email), ''), 'Authenticated user'),
           upper(coalesce(nullif(btrim(role::text), ''), 'USER'))
      into v_actor_name, v_actor_role from public.profiles where id = v_actor_id;
    v_actor_name := coalesce(v_actor_name, 'Authenticated user');
    v_actor_role := coalesce(v_actor_role, 'USER');
  end if;
  select coalesce(nullif(btrim(full_name), ''), 'Staff account') into v_old from public.profiles where id = old.staff_id;
  select coalesce(nullif(btrim(full_name), ''), 'Staff account') into v_new from public.profiles where id = new.staff_id;
  v_label := coalesce(nullif(btrim(concat_ws(' ', new.brand, new.model)), ''), new.plate_number, 'vehicle');
  insert into public.audit_logs (booking_id, action_type, details, actor_name, actor_role, actor_id, metadata, created_at)
  values (new.booking_id, 'STAFF_ASSIGNMENT_CHANGED',
          case when v_old is null then format('Assigned %s to %s (booking #%s).', v_new, v_label, left(new.booking_id::text, 8))
               when v_new is null then format('Removed %s from %s (booking #%s).', v_old, v_label, left(new.booking_id::text, 8))
               else format('Changed %s (booking #%s) from %s to %s.', v_label, left(new.booking_id::text, 8), v_old, v_new) end,
          v_actor_name, v_actor_role, v_actor_id,
          jsonb_strip_nulls(jsonb_build_object('vehicle_id', new.id, 'previous_staff_id', old.staff_id, 'previous_staff_name', v_old,
                                               'new_staff_id', new.staff_id, 'new_staff_name', v_new)),
          now());
  return null;
end;
$$;
drop trigger if exists trg_audit_vehicle_staff_assignment on public.booking_vehicles;
create trigger trg_audit_vehicle_staff_assignment
  after update of staff_id on public.booking_vehicles
  for each row when (old.staff_id is distinct from new.staff_id)
  execute function public.audit_vehicle_staff_assignment();

-- the booking-level audit would repeat a change that came from a vehicle (or that it propagated)
do $$
declare v_def text := pg_get_functiondef('public.audit_booking_staff_assignment()'::regprocedure);
begin
  if v_def not like '%pg_trigger_depth%' then
    -- (the stored text may use Windows line endings, so the first "begin" line is matched either way)
    v_def := regexp_replace(v_def, E'\\ybegin(\\r?\\n)', E'begin\\1  if pg_trigger_depth() > 1 then return new; end if;\\1');
    if v_def not like '%pg_trigger_depth%' then raise exception 'could not patch audit_booking_staff_assignment'; end if;
    execute v_def;
  end if;
end $$;

-- 7. functions that decide what a technician may touch
create or replace function public.staff_has_active_services(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bookings as b
     where b.staff_id = p_staff_id
       and lower(coalesce(b.status, '')) in ('pending', 'pending_confirmation', 'scheduled', 'confirmed', 'in_progress', 'ongoing', 'submitted')
  )
  or exists (
    select 1 from public.booking_vehicles as bv
      join public.bookings as b on b.id = bv.booking_id
     where bv.staff_id = p_staff_id
       and lower(coalesce(b.status, '')) in ('pending', 'pending_confirmation', 'scheduled', 'confirmed', 'in_progress', 'ongoing', 'submitted')
  )
  or exists (
    select 1 from public.booking_vehicles as bv
      join public.bookings as b on b.id = bv.booking_id
     where bv.staff_id = p_staff_id
       and upper(coalesce(bv.status, '')) in ('IN_PROGRESS', 'ONGOING')
       and lower(coalesce(b.status, '')) not in ('cancelled', 'completed', 'released', 'flagged_noshow', 'no_show')
  );
$$;

create or replace function public.staff_booking_has_verified_downpayment(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.booking_ledger_v l
      join public.profiles p on p.id = auth.uid() and upper(p.role) = 'STAFF'
     where l.booking_id = p_booking_id
       and (l.staff_id = auth.uid() or exists (select 1 from public.booking_vehicles bv where bv.booking_id = p_booking_id and bv.staff_id = auth.uid()))
       and l.downpayment_met
  );
$$;

do $$
declare v_def text := pg_get_functiondef('public.update_booking_vehicle_service_notes(uuid, text)'::regprocedure);
begin
  if v_def not like '%select v.staff_id, b.status%' then
    v_def := regexp_replace(v_def, 'select (coalesce\(v\.staff_id, b\.staff_id\)|b\.staff_id), b\.status', 'select v.staff_id, b.status');
    if v_def not like '%select v.staff_id, b.status%' then raise exception 'could not patch update_booking_vehicle_service_notes'; end if;
    execute v_def;
  end if;
end $$;

-- 8. what the customer sees: every technician, per vehicle
create or replace function public.get_customer_booking_technicians(p_booking_id uuid)
returns table (vehicle_id uuid, technician_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not (public.is_admin() or exists (select 1 from public.bookings where id = p_booking_id and customer_id = auth.uid())) then
    raise exception 'Booking access denied';
  end if;
  return query
    select bv.id,
           coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(concat_ws(' ', pr.first_name, pr.last_name)), ''))
      from public.booking_vehicles bv
      join public.bookings b on b.id = bv.booking_id
      left join public.profiles pr on pr.id = bv.staff_id
     where bv.booking_id = p_booking_id
     order by bv.created_at, bv.id;
end;
$$;
revoke all on function public.get_customer_booking_technicians(uuid) from public, anon;
grant execute on function public.get_customer_booking_technicians(uuid) to authenticated;

-- the older single-name function now lists the distinct technicians
create or replace function public.get_customer_booking_technician(p_booking_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_names text;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not (public.is_admin() or exists (select 1 from public.bookings where id = p_booking_id and customer_id = auth.uid())) then
    raise exception 'Booking access denied';
  end if;
  select string_agg(distinct t.technician_name, ', ') into v_names
    from public.get_customer_booking_technicians(p_booking_id) t
   where t.technician_name is not null;
  return v_names;
end;
$$;

-- 9. row-level security: a technician sees only their own vehicles
drop policy if exists bookings_select_assigned_staff on public.bookings;
create policy bookings_select_assigned_staff on public.bookings
  for select to authenticated
  using (staff_id = (select auth.uid()) or public.staff_on_booking(id));

drop policy if exists booking_vehicles_select_assigned_staff on public.booking_vehicles;
create policy booking_vehicles_select_assigned_staff on public.booking_vehicles
  for select to authenticated
  using (staff_id = (select auth.uid()));

drop policy if exists booking_vehicle_services_select_assigned_staff on public.booking_vehicle_services;
create policy booking_vehicle_services_select_assigned_staff on public.booking_vehicle_services
  for select to authenticated
  using (public.vehicle_technician(booking_vehicle_id) = (select auth.uid()));

drop policy if exists service_photos_select_owner_staff_admin on public.service_photos;
create policy service_photos_select_owner_staff_admin on public.service_photos
  for select to authenticated
  using (
    exists (select 1 from public.bookings b where b.id = service_photos.booking_id and b.customer_id = (select auth.uid()))
    or (public.staff_can_see_photo(booking_id, booking_vehicle_id) and public.staff_booking_has_verified_downpayment(booking_id))
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and upper(p.role) = 'ADMIN')
  );

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
             (service_photos.phase = 'before' and upper(v.status) = any (array['PENDING', 'SCHEDULED', 'CONFIRMED']))
             or (service_photos.phase = 'after' and upper(v.status) = 'IN_PROGRESS')
           )
      )
      and not public.vehicle_has_photo_phase(booking_vehicle_id, phase)
    )
  );

-- 10. "a service was added" goes to the technician of THAT vehicle
drop function if exists public.notify_service_added(uuid, text, text);
create or replace function public.notify_service_added(
  p_booking_id uuid,
  p_service_name text,
  p_actor_role text,
  p_vehicle_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_booking public.bookings%rowtype;
  v_ref text;
  v_staff uuid;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then return; end if;
  v_ref := left(p_booking_id::text, 8);
  v_staff := case when p_vehicle_id is not null then public.vehicle_technician(p_vehicle_id) else v_booking.staff_id end;

  if upper(coalesce(p_actor_role, '')) = 'CUSTOMER' then
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    select p.id, 'Service Added by Customer',
           'The customer added "' || p_service_name || '" to booking #' || v_ref || '.',
           'SERVICE_ADDED', '/admin/bookings/' || p_booking_id, p_booking_id, p_booking_id, false
      from public.profiles p
     where upper(p.role) = 'ADMIN' and coalesce(p.is_active, true);
  elsif v_booking.customer_id is not null then
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    values (v_booking.customer_id, 'Service Added',
            '"' || p_service_name || '" was added to your booking #' || v_ref || '. Your total and finish time were updated.',
            'SERVICE_ADDED', '/customer/bookings/' || p_booking_id, p_booking_id, p_booking_id, false);
  end if;

  if v_staff is not null then
    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    values (v_staff, 'Job Updated',
            '"' || p_service_name || '" was added to booking #' || v_ref || '. Check the job for the new work and finish time.',
            'JOB_UPDATED', '/staff/tasks', p_booking_id, p_booking_id, false);
  end if;
end;
$fn$;
revoke all on function public.notify_service_added(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.notify_service_added(uuid, text, text, uuid) to service_role;

do $$
declare v_def text := pg_get_functiondef('public.apply_added_service(uuid, uuid, text, numeric, integer, text, jsonb, uuid, uuid, text, text, text)'::regprocedure);
begin
  if v_def not like '%p_actor_role, p_vehicle_id%' then
    v_def := replace(v_def, 'notify_service_added(p_booking_id, p_service_name, p_actor_role)', 'notify_service_added(p_booking_id, p_service_name, p_actor_role, p_vehicle_id)');
    if v_def not like '%p_actor_role, p_vehicle_id%' then raise exception 'could not patch apply_added_service'; end if;
    execute v_def;
  end if;
end $$;
