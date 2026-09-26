-- ============================================================================
-- 20261019000004_booking_delete_cascade.sql
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Deleting a booking fails outright:
--
--     ERROR: update or delete on table "booking_vehicles" violates foreign key
--            constraint "booking_vehicle_services_booking_vehicle_id_fkey"
--            on table "booking_vehicle_services"
--
-- The chain breaks in the middle. `booking_vehicles.booking_id` cascades from
-- `bookings`, but `booking_vehicle_services.booking_vehicle_id` does NOT cascade
-- from `booking_vehicles`. So the database deletes the parent vehicle, then
-- finds service rows still pointing at it and aborts the whole statement.
--
-- IMPACT
-- ------
-- A booking can never be hard-deleted. Any admin purge, data-retention job,
-- cleanup of abandoned carts, or "remove this test booking" action fails with a
-- raw constraint error. It also means abandoned unpaid holds accumulate
-- permanently — the auto-release sweep can only CANCEL them (soft state), never
-- remove them.
--
-- THE FIX
-- -------
-- Make the child services cascade with their parent vehicle, completing the
-- chain: bookings -> booking_vehicles -> booking_vehicle_services. Deleting a
-- booking now removes its entire tree in one statement, which is the behaviour
-- every caller already assumed.
--
-- NOTE ON DESIGN: this makes HARD deletion work. Normal customer-facing
-- cancellation still uses status changes (soft cancellation), which is correct —
-- a booking record is an audit artifact. This only removes the constraint that
-- made legitimate hard deletes impossible.
--
-- IDEMPOTENT: the constraint is dropped by name if present and recreated, so
-- re-running converges on the same definition.
-- ============================================================================

-- ── 1. booking_vehicle_services -> booking_vehicles ─────────────────────────
do $cascade_services$
declare
  v_constraint text;
  v_nullable   boolean;
begin
  -- Only proceed if the table actually has the FK column.
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'booking_vehicle_services'
       and column_name = 'booking_vehicle_id'
  ) into v_nullable;

  if not v_nullable then
    raise notice 'booking_vehicle_services.booking_vehicle_id not found — skipping.';
    return;
  end if;

  -- Find whatever the FK is currently called and drop it, rather than assuming
  -- a name. Constraint names differ between environments when a table was
  -- created by an older migration.
  for v_constraint in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'booking_vehicle_services'
       and con.contype = 'f'
       and con.confrelid = 'public.booking_vehicles'::regclass
  loop
    execute format('alter table public.booking_vehicle_services drop constraint %I', v_constraint);
    raise notice 'Dropped old FK % on booking_vehicle_services.', v_constraint;
  end loop;

  alter table public.booking_vehicle_services
    add constraint booking_vehicle_services_booking_vehicle_id_fkey
    foreign key (booking_vehicle_id)
    references public.booking_vehicles(id)
    on delete cascade;

  raise notice 'booking_vehicle_services now cascades from booking_vehicles.';
end $cascade_services$;


-- ── 2. booking_email_deliveries already cascades from bookings ──────────────
-- Created with `on delete cascade` in 20261019000003; asserted here so a future
-- edit to that file cannot silently reintroduce a delete blocker.
do $verify_deliveries$
begin
  if not exists (
    select 1
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'booking_email_deliveries'
       and con.contype = 'f'
       and con.confrelid = 'public.bookings'::regclass
       and con.confdeltype = 'c'
  ) then
    -- Recreate it properly rather than leaving a delete blocker behind.
    execute 'alter table public.booking_email_deliveries drop constraint if exists booking_email_deliveries_booking_id_fkey';
    execute 'alter table public.booking_email_deliveries
               add constraint booking_email_deliveries_booking_id_fkey
               foreign key (booking_id) references public.bookings(id) on delete cascade';
    raise notice 'Repaired booking_email_deliveries cascade.';
  end if;
end $verify_deliveries$;


-- ── 3. A callable purge that respects the whole tree ────────────────────────
-- Callers that need to remove a booking (admin purge, abandoned-cart cleanup,
-- test teardown) should not have to know the child-table graph. This wraps it,
-- is SECURITY DEFINER so it bypasses RLS consistently, and is restricted to
-- admins so a customer cannot delete their own booking history.
create or replace function public.delete_booking_cascade(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_services integer := 0;
  v_vehicles integer := 0;
  v_payments integer := 0;
  v_notes    integer := 0;
  v_emails   integer := 0;
begin
  if p_booking_id is null then
    raise exception 'delete_booking_cascade: booking id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  if not public.is_admin() and auth.role() <> 'service_role' then
    raise exception 'delete_booking_cascade: administrator privileges required'
      using errcode = 'insufficient_privilege';
  end if;

  -- Delete leaves-first explicitly. The cascades now make this redundant, but
  -- doing it in order keeps the function correct even if a future migration
  -- changes a constraint back to RESTRICT.
  delete from public.booking_vehicle_services
   where booking_vehicle_id in (select id from public.booking_vehicles where booking_id = p_booking_id);
  get diagnostics v_services = row_count;

  delete from public.booking_vehicles where booking_id = p_booking_id;
  get diagnostics v_vehicles = row_count;

  delete from public.payments where booking_id = p_booking_id;
  get diagnostics v_payments = row_count;

  delete from public.notifications where booking_id = p_booking_id;
  get diagnostics v_notes = row_count;

  delete from public.booking_email_deliveries where booking_id = p_booking_id;
  get diagnostics v_emails = row_count;

  delete from public.bookings where id = p_booking_id;

  if not found then
    return jsonb_build_object('deleted', false, 'reason', 'NOT_FOUND');
  end if;

  return jsonb_build_object(
    'deleted', true,
    'services', v_services,
    'vehicles', v_vehicles,
    'payments', v_payments,
    'notifications', v_notes,
    'email_deliveries', v_emails
  );
end;
$$;

comment on function public.delete_booking_cascade(uuid) is
  'Removes a booking and its entire child tree (services, vehicles, payments, notifications, email-delivery ledger) in one transaction. Exists because the missing booking_vehicle_services cascade made hard deletes impossible. Admin/service-role only.';

revoke all on function public.delete_booking_cascade(uuid) from public;
grant execute on function public.delete_booking_cascade(uuid) to authenticated;