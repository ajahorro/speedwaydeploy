-- ============================================================================
-- Repair phantom bookings left by the old non-atomic createBooking() path
-- ============================================================================
-- Before create_booking_atomic() (see 20261001000001_create_booking_atomic.sql)
-- a failure between the master-booking insert and the child inserts left
-- booking rows with total_amount set but no booking_vehicles / payments.
--
-- Repairs:
--   A. 7d1c46e4-... Reconstruct the missing unit + payment. This booking is a
--      Moto Wash (₱120) walk-in that is IDENTICAL to its sibling e58ca670-...
--      (same customer, contact, plate NZ40EZ, ₱120, 03:30 slot, Moto Wash
--      service). Its own service_snapshot is empty (the loss happened before
--      the snapshot write), so the sibling is the authoritative source for
--      what this booking should contain.
--   B. e5b3cf4b-... Totally empty phantom (total_amount 0, no datetimes, no
--      notes, no customer, no service) — nothing recoverable. Delete it.
--   C. 4c912062-... Dangling booking_vehicles row with booking_id = null and
--      status 'pending' — an orphaned child of the same bug. Delete it.
-- Idempotent: each step guards on the current state.
-- ============================================================================

do $$
declare
  v_booking_id   uuid := '7d1c46e4-d9d5-4f7a-aa61-9ff607aeecc5';
  v_vehicle_id   uuid;
  v_has_vehicle  boolean;
  v_has_payment  boolean;
begin
  -- ── A. Reconstruct the lost unit + payment for the phantom walk-in ────────
  select exists (select 1 from public.booking_vehicles where booking_id = v_booking_id)
    into v_has_vehicle;

  if not v_has_vehicle then
    insert into public.booking_vehicles (
      booking_id, vehicle_type, brand, model, plate_number, status, subtotal
    )
    values (
      v_booking_id, 'Regular', 'Bracko', 'Bracko', 'NZ40EZ', 'SCHEDULED', 120
    )
    returning id into v_vehicle_id;

    insert into public.booking_vehicle_services (
      booking_vehicle_id, service_name, price, final_price, base_price,
      price_at_booking, duration_snapshot, vehicle_type, service_version,
      service_name_snapshot, price_snapshot
    )
    values (
      v_vehicle_id, 'Moto Wash', 120, 120, 120, 120, 30, 'Regular', 1,
      'Moto Wash', 120
    );
  end if;

  select exists (select 1 from public.payments where booking_id = v_booking_id)
    into v_has_payment;

  if not v_has_payment then
    insert into public.payments (
      booking_id, amount, method, payment_type, status, notes
    )
    values (
      v_booking_id, 120, 'GCash', 'Full', 'PAID',
      'RECONSTRUCTED|Phantom booking repaired after non-atomic create defect.'
    );
  end if;

  -- Backfill walk-in provenance the phantom is missing (its siblings carry it).
  update public.bookings
     set is_walk_in = true,
         notes = case when notes is null or notes = '' then 'WALK-IN' else notes end
   where id = v_booking_id
     and (is_walk_in = false or notes is null or notes = '');
end;
$$;

-- ── B. Delete the unrecoverable empty phantom ───────────────────────────────
delete from public.payments
 where booking_id = 'e5b3cf4b-8f96-4a95-8393-78d33a83f98a';
delete from public.booking_vehicle_services
 where booking_vehicle_id in (
   select id from public.booking_vehicles
    where booking_id = 'e5b3cf4b-8f96-4a95-8393-78d33a83f98a'
 );
delete from public.booking_vehicles
 where booking_id = 'e5b3cf4b-8f96-4a95-8393-78d33a83f98a';
delete from public.audit_logs
 where booking_id = 'e5b3cf4b-8f96-4a95-8393-78d33a83f98a';
delete from public.bookings
 where id = 'e5b3cf4b-8f96-4a95-8393-78d33a83f98a'
   and total_amount = 0
   and start_datetime is null;

-- ── C. Delete the dangling child row (no parent booking) ────────────────────
delete from public.booking_vehicle_services
 where booking_vehicle_id = '4c912062-bfd6-4f46-b9ad-ac3c8512f743';
delete from public.booking_vehicles
 where id = '4c912062-bfd6-4f46-b9ad-ac3c8512f743'
   and booking_id is null;