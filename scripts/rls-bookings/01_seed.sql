-- Throwaway fixtures for the local RLS test stack. Never run against production.
\set ON_ERROR_STOP 1
begin;
insert into auth.users (id, email, aud, role, instance_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cust.a@rls.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'cust.b@rls.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'staff.s@rls.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'staff.t@rls.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('cccccccc-0000-4000-8000-000000000001', 'admin@rls.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into public.profiles (id, email, full_name, role, is_active) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cust.a@rls.test',  'Customer A', 'CUSTOMER', true),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'cust.b@rls.test',  'Customer B', 'CUSTOMER', true),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'staff.s@rls.test', 'Staff S',    'STAFF',    true),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'staff.t@rls.test', 'Staff T',    'STAFF',    true),
  ('cccccccc-0000-4000-8000-000000000001', 'admin@rls.test',   'Admin',      'ADMIN',    true)
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

insert into public.business_config (opening_hour, closing_hour, is_24_7, slots_per_hour, enforce_capacity,
                                    qr_account_name, qr_account_number, gcash_qr_url, qr_config_version)
select '08:00 AM', '06:00 PM', true, 4, true, 'Speedway Test', '09170000000', 'https://example.test/qr.png', 3
where not exists (select 1 from public.business_config);

-- Fixed future window: 2026-11-10 (Asia/Manila).
insert into public.bookings (id, customer_id, staff_id, start_datetime, end_datetime, status, total_amount, customer_name, customer_phone, customer_email) values
  ('d0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
   '2026-11-10 10:00+08', '2026-11-10 12:00+08', 'confirmed', 1500, 'Customer A', '0917-AAA', 'cust.a@rls.test'),
  ('d0000000-0000-4000-8000-0000000000b1', 'aaaaaaaa-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   '2026-11-10 11:00+08', '2026-11-10 13:00+08', 'confirmed', 2500, 'Customer B', '0917-BBB', 'cust.b@rls.test'),
  ('d0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', null,
   '2026-11-10 14:00+08', '2026-11-10 15:00+08', 'pending', 900, 'Customer A', '0917-AAA', 'cust.a@rls.test');

insert into public.booking_vehicles (booking_id, vehicle_type, brand, model, plate_number, status) values
  ('d0000000-0000-4000-8000-0000000000a1', 'Sedan',      'Toyota', 'Vios',  'AAA111', 'SCHEDULED'),
  ('d0000000-0000-4000-8000-0000000000b1', 'SUV',        'Ford',   'Everest','BBB222', 'SCHEDULED'),
  ('d0000000-0000-4000-8000-0000000000b1', 'Motorcycle', 'Honda',  'Click', 'BBB333', 'SCHEDULED'),
  ('d0000000-0000-4000-8000-0000000000a2', 'Sedan',      'Toyota', 'Vios',  'AAA111', 'SCHEDULED');
commit;
