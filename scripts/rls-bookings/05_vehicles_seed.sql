-- Extra fixtures for the booking_vehicles / booking_vehicle_services matrix.
-- Run after 01_seed.sql on the throwaway local stack. Never run against production.
\set ON_ERROR_STOP 1
begin;
-- Fixture rows only: skip status/evidence triggers so a finished booking can be
-- inserted directly.
set local session_replication_role = replica;

-- a3: Customer A / Staff S, finished (for StaffWorkHistory and the
-- "notes on a finalized booking" check).
insert into public.bookings (id, customer_id, staff_id, start_datetime, end_datetime, status, total_amount, customer_name, customer_phone, customer_email) values
  ('d0000000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
   '2026-10-01 10:00+08', '2026-10-01 11:00+08', 'completed', 700, 'Customer A', '0917-AAA', 'cust.a@rls.test');
insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, service_notes) values
  ('e0000000-0000-4000-8000-0000000000a3', 'd0000000-0000-4000-8000-0000000000a3', 'Sedan', 'Toyota', 'Vios', 'AAA111', 'COMPLETED', 'done');

-- Fixed ids on the 01_seed vehicles so checks can target them.
update public.booking_vehicles set id = 'e0000000-0000-4000-8000-0000000000a1' where booking_id = 'd0000000-0000-4000-8000-0000000000a1';
update public.booking_vehicles set id = 'e0000000-0000-4000-8000-0000000000a2' where booking_id = 'd0000000-0000-4000-8000-0000000000a2';
update public.booking_vehicles set id = 'e0000000-0000-4000-8000-0000000000b1' where booking_id = 'd0000000-0000-4000-8000-0000000000b1' and plate_number = 'BBB222';
update public.booking_vehicles set id = 'e0000000-0000-4000-8000-0000000000b2' where booking_id = 'd0000000-0000-4000-8000-0000000000b1' and plate_number = 'BBB333';

-- One service line per vehicle (a1, a2, a3, b1, b2).
insert into public.booking_vehicle_services (booking_vehicle_id, service_name, price, final_price, base_price, price_at_booking, duration_minutes, vehicle_type)
select v.id, 'Wash ' || right(v.id::text, 2), 500, 500, 500, 500, 60, v.vehicle_type
  from public.booking_vehicles v
 where v.id::text like 'e0000000-%';
commit;
