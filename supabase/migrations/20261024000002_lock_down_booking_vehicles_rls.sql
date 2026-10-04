-- Lock down public.booking_vehicles and public.booking_vehicle_services RLS.
--
-- PROBLEM
--   Production carried two policies that no migration in this repository
--   created (added out-of-band, e.g. from the dashboard):
--
--     CREATE POLICY "Public full access on vehicles" ON public.booking_vehicles
--       USING (true) WITH CHECK (true);
--     CREATE POLICY "Public full access on services" ON public.booking_vehicle_services
--       USING (true) WITH CHECK (true);
--
--   No TO clause means PUBLIC, so anyone holding the public anon key could
--   SELECT, INSERT, UPDATE and DELETE every vehicle line (plate, brand, model,
--   status, service notes) and every service line (names, prices).
--
-- NEW MODEL (scoped through the parent booking, same rules as
-- 20261024000001_lock_down_bookings_rls.sql)
--   * Customers:   SELECT lines of their own bookings (bookings.customer_id).
--   * Staff:       SELECT lines of bookings assigned to them (bookings.staff_id).
--   * Admins:      full access via public.is_admin() (live, active ADMIN role).
--   * anon:        nothing.
--   * Browser writes by non-admins: none. Booking creation, reschedule,
--     cancellation and status changes already go through SECURITY DEFINER RPCs
--     or the backend's service-role client.
--
-- FLOW THAT NEEDED AN RPC
--   StaffDashboard and StaffActiveJobs saved technician notes with a direct
--   `update booking_vehicles set service_notes = ...`. That now goes through
--   update_booking_vehicle_service_notes(), which only lets the active staff
--   member assigned to the parent booking (or an admin) change the notes column
--   and nothing else.

begin;

-- ---------------------------------------------------------------------------
-- 1. booking_vehicles policies
-- ---------------------------------------------------------------------------

alter table public.booking_vehicles enable row level security;

drop policy if exists "Public full access on vehicles" on public.booking_vehicles;
drop policy if exists booking_vehicles_select_own_customer on public.booking_vehicles;
drop policy if exists booking_vehicles_select_assigned_staff on public.booking_vehicles;
drop policy if exists booking_vehicles_admin_all on public.booking_vehicles;

create policy booking_vehicles_select_own_customer
  on public.booking_vehicles
  for select
  to authenticated
  using (exists (
    select 1
      from public.bookings b
     where b.id = booking_vehicles.booking_id
       and b.customer_id = (select auth.uid())
  ));

create policy booking_vehicles_select_assigned_staff
  on public.booking_vehicles
  for select
  to authenticated
  using (exists (
    select 1
      from public.bookings b
     where b.id = booking_vehicles.booking_id
       and b.staff_id = (select auth.uid())
  ));

create policy booking_vehicles_admin_all
  on public.booking_vehicles
  for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- 2. booking_vehicle_services policies
-- ---------------------------------------------------------------------------

alter table public.booking_vehicle_services enable row level security;

drop policy if exists "Public full access on services" on public.booking_vehicle_services;
drop policy if exists booking_vehicle_services_select_own_customer on public.booking_vehicle_services;
drop policy if exists booking_vehicle_services_select_assigned_staff on public.booking_vehicle_services;
drop policy if exists booking_vehicle_services_admin_all on public.booking_vehicle_services;

create policy booking_vehicle_services_select_own_customer
  on public.booking_vehicle_services
  for select
  to authenticated
  using (exists (
    select 1
      from public.booking_vehicles v
      join public.bookings b on b.id = v.booking_id
     where v.id = booking_vehicle_services.booking_vehicle_id
       and b.customer_id = (select auth.uid())
  ));

create policy booking_vehicle_services_select_assigned_staff
  on public.booking_vehicle_services
  for select
  to authenticated
  using (exists (
    select 1
      from public.booking_vehicles v
      join public.bookings b on b.id = v.booking_id
     where v.id = booking_vehicle_services.booking_vehicle_id
       and b.staff_id = (select auth.uid())
  ));

create policy booking_vehicle_services_admin_all
  on public.booking_vehicle_services
  for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Table privileges: the live schema granted ALL to anon and to PUBLIC (which
-- anon inherits). Remove them as defense in depth so a future permissive policy
-- cannot re-open these tables to unauthenticated callers. authenticated and
-- service_role keep their grants.
revoke all on table public.booking_vehicles from anon;
revoke all on table public.booking_vehicles from public;
revoke all on table public.booking_vehicle_services from anon;
revoke all on table public.booking_vehicle_services from public;

-- ---------------------------------------------------------------------------
-- 3. update_booking_vehicle_service_notes: staff notes without UPDATE on the table
-- ---------------------------------------------------------------------------

create or replace function public.update_booking_vehicle_service_notes(
  p_vehicle_id uuid,
  p_notes text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_booking_status text;
  v_notes text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select b.staff_id, b.status
    into v_staff_id, v_booking_status
    from public.booking_vehicles v
    join public.bookings b on b.id = v.booking_id
   where v.id = p_vehicle_id;

  -- Same "not found" for a missing vehicle and for one the caller may not
  -- touch, so the RPC cannot be used to probe other bookings.
  if not found
     or not (
       public.is_admin()
       or (
         v_staff_id = auth.uid()
         and exists (
           select 1 from public.profiles p
            where p.id = auth.uid()
              and upper(coalesce(p.role, '')) = 'STAFF'
              and coalesce(p.is_active, true) = true
         )
       )
     ) then
    raise exception 'Vehicle not found.' using errcode = 'P0002';
  end if;

  if lower(coalesce(v_booking_status, '')) in ('completed', 'released', 'cancelled', 'flagged_noshow', 'no_show') then
    raise exception 'This booking is finalized.' using errcode = '22023';
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  if length(v_notes) > 4000 then
    raise exception 'Notes are too long (max 4000 characters).' using errcode = '22001';
  end if;

  update public.booking_vehicles
     set service_notes = v_notes
   where id = p_vehicle_id;

  return v_notes;
end;
$$;

comment on function public.update_booking_vehicle_service_notes(uuid, text) is
  'Sets booking_vehicles.service_notes for the active staff member assigned to the parent booking (or an admin). Replaces the former direct client UPDATE on booking_vehicles, which is no longer granted to non-admins by RLS.';

revoke all on function public.update_booking_vehicle_service_notes(uuid, text) from public;
revoke all on function public.update_booking_vehicle_service_notes(uuid, text) from anon;
grant execute on function public.update_booking_vehicle_service_notes(uuid, text) to authenticated;
grant execute on function public.update_booking_vehicle_service_notes(uuid, text) to service_role;

commit;
