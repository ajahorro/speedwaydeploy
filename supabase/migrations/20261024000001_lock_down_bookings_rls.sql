-- Lock down public.bookings row-level security.
--
-- PROBLEM
--   Production carried a single policy on bookings that no migration in this
--   repository created (it was added out-of-band, e.g. from the dashboard):
--
--     CREATE POLICY "Users can access bookings" ON public.bookings
--       TO anon, authenticated USING (true) WITH CHECK (true);
--
--   FOR ALL + USING (true) let anyone holding the public anon key SELECT,
--   INSERT, UPDATE and DELETE every booking (names, phone numbers, amounts,
--   payment state, staff assignment, QR snapshot).
--
-- NEW MODEL (least privilege)
--   * Customers:   SELECT their own bookings (customer_id = auth.uid()).
--   * Staff:       SELECT bookings assigned to them (staff_id = auth.uid()).
--   * Admins:      full access via public.is_admin() (live, active ADMIN role).
--   * anon:        nothing. No anonymous flow reads or writes bookings;
--                  booking creation is create_booking_atomic_secure, which is
--                  granted to authenticated only.
--   * Browser writes by non-admins: none. Every customer/staff mutation already
--     goes through SECURITY DEFINER RPCs (create_booking_atomic_secure,
--     reschedule_booking, ...) or the backend's service-role client
--     (cancellation, staff task queue), which are unaffected by RLS.
--
-- FLOWS THAT NEEDED AN RPC
--   1. Slot/capacity checks in the booking wizard and reschedule modals read
--      every booking overlapping a window (other customers' bookings included)
--      to count occupied bays. With own-only RLS they would silently undercount
--      and offer full slots. get_schedule_occupancy() returns only the
--      non-identifying fields the rules engine uses: times, status, and
--      per-vehicle type/status. No booking id, customer, staff, amount or plate.
--   2. The payment step re-captured the QR snapshot onto an existing booking
--      with a direct client UPDATE. capture_booking_qr_snapshot() now does it
--      for the booking's owner (or an admin), building the snapshot from the
--      server's business_config like the default_qr_snapshot() insert trigger.

begin;

-- ---------------------------------------------------------------------------
-- 1. Policies
-- ---------------------------------------------------------------------------

alter table public.bookings enable row level security;

drop policy if exists "Users can access bookings" on public.bookings;
drop policy if exists bookings_select_own_customer on public.bookings;
drop policy if exists bookings_select_assigned_staff on public.bookings;
drop policy if exists bookings_admin_all on public.bookings;

create policy bookings_select_own_customer
  on public.bookings
  for select
  to authenticated
  using (customer_id = (select auth.uid()));

create policy bookings_select_assigned_staff
  on public.bookings
  for select
  to authenticated
  using (staff_id = (select auth.uid()));

create policy bookings_admin_all
  on public.bookings
  for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Table privileges: the live schema granted ALL to anon and to PUBLIC (which
-- anon inherits). RLS already denies anon every row now, but remove the grants
-- as defense in depth so a future permissive policy cannot re-open the table to
-- unauthenticated callers. authenticated and service_role keep their grants.
revoke all on table public.bookings from anon;
revoke all on table public.bookings from public;

-- Booking creation is authenticated-only. Production already grants this RPC
-- to authenticated/service_role only; make that explicit so a default-privilege
-- grant (Supabase auto-grants anon EXECUTE on new functions) cannot re-open it.
revoke execute on function public.create_booking_atomic_secure(jsonb) from anon;
revoke execute on function public.create_booking_atomic_secure(jsonb) from public;

-- ---------------------------------------------------------------------------
-- 2. get_schedule_occupancy: capacity data without booking identities
-- ---------------------------------------------------------------------------

create or replace function public.get_schedule_occupancy(
  p_start timestamptz,
  p_end timestamptz,
  p_exclude_booking_id uuid default null
)
returns table (
  start_datetime timestamptz,
  end_datetime timestamptz,
  status text,
  vehicles jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'A valid time window is required.' using errcode = '22023';
  end if;
  -- Callers ask for a few hours (fleet editing) up to a few days (multi-day
  -- services). Cap the window so the schedule cannot be bulk-exported.
  if p_end - p_start > interval '14 days' then
    raise exception 'Time window too large (max 14 days).' using errcode = '22023';
  end if;

  return query
    select b.start_datetime,
           b.end_datetime,
           b.status,
           coalesce(
             (select jsonb_agg(jsonb_build_object('vehicle_type', v.vehicle_type, 'status', v.status))
                from public.booking_vehicles v
               where v.booking_id = b.id),
             '[]'::jsonb
           )
      from public.bookings b
     where b.start_datetime < p_end
       and b.end_datetime > p_start
       and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id);
end;
$$;

comment on function public.get_schedule_occupancy(timestamptz, timestamptz, uuid) is
  'Occupancy for slot/capacity checks: times, status and per-vehicle type/status of every booking overlapping [p_start, p_end). Returns no booking id, customer, staff, amount or plate, so customers can compute availability without bookings SELECT on other customers'' rows.';

revoke all on function public.get_schedule_occupancy(timestamptz, timestamptz, uuid) from public;
revoke all on function public.get_schedule_occupancy(timestamptz, timestamptz, uuid) from anon;
grant execute on function public.get_schedule_occupancy(timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.get_schedule_occupancy(timestamptz, timestamptz, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. capture_booking_qr_snapshot: owner/admin QR re-snapshot
-- ---------------------------------------------------------------------------

create or replace function public.capture_booking_qr_snapshot(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_status text;
  v_cfg jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select customer_id, status
    into v_customer_id, v_status
    from public.bookings
   where id = p_booking_id;

  if not found or (v_customer_id is distinct from auth.uid() and not public.is_admin()) then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  if upper(coalesce(v_status, '')) in ('CANCELLED', 'COMPLETED', 'RELEASED', 'FLAGGED_NOSHOW') then
    raise exception 'This booking is finalized.' using errcode = '22023';
  end if;

  -- Same shape as default_qr_snapshot(): taken from the server's live config,
  -- never from client-supplied values.
  select jsonb_build_object(
           'qr_account_name', qr_account_name,
           'qr_account_number', qr_account_number,
           'payment_qr_url', coalesce(payment_qr_url, gcash_qr_url, qr_photo_url),
           'gcash_qr_url', coalesce(gcash_qr_url, payment_qr_url, qr_photo_url),
           'qr_photo_url', coalesce(qr_photo_url, payment_qr_url, gcash_qr_url),
           'qr_config_version', coalesce(qr_config_version, 1),
           'captured_at', now()
         )
    into v_cfg
    from public.business_config
   order by id
   limit 1;

  if v_cfg is null then
    return null;
  end if;

  update public.bookings
     set active_qr_snapshot = v_cfg,
         qr_snapshot_version = coalesce((v_cfg ->> 'qr_config_version')::integer, 1)
   where id = p_booking_id;

  return v_cfg;
end;
$$;

comment on function public.capture_booking_qr_snapshot(uuid) is
  'Re-stamps an open booking with the CURRENT server QR config when its owner (or an admin) opens the payment step. Replaces the former direct client UPDATE on bookings.';

revoke all on function public.capture_booking_qr_snapshot(uuid) from public;
revoke all on function public.capture_booking_qr_snapshot(uuid) from anon;
grant execute on function public.capture_booking_qr_snapshot(uuid) to authenticated;
grant execute on function public.capture_booking_qr_snapshot(uuid) to service_role;

commit;
