-- Local scratch database only. Four tagged bookings (notes = PHOTOTEST) for the photo upload tests.
--   a...01  paid, time reached, assigned to real-staff     -> the normal case
--   a...02  paid, starts in 3 hours, assigned to real-staff -> "not before the scheduled time" + early start
--   a...03  paid, time reached, assigned to staff@test.local -> another technician must be refused
--   a...04  NOT paid, time reached, assigned to real-staff   -> no verified downpayment, must be refused
set session_replication_role = replica;

delete from public.service_photos where booking_id::text like 'a0000000-%';
delete from public.payments where booking_id::text like 'a0000000-%';
delete from public.booking_vehicles where booking_id::text like 'a0000000-%';
delete from public.bookings where id::text like 'a0000000-%';

select id as cust from public.profiles where email = 'cust@test.local' \gset
select id as tech from public.profiles where email = 'real-staff@test.local' \gset
select id as other from public.profiles where email = 'staff@test.local' \gset

insert into public.bookings (id, customer_id, customer_name, customer_email, contact_number, status, payment_status, payment_method, payment_type, total_amount, balance_due, start_datetime, end_datetime, staff_id, notes)
values
 ('a0000000-0000-0000-0000-000000000001', :'cust', 'Test Customer', 'cust@test.local', '09171234567', 'confirmed', 'paid',   'GCASH', 'Full', 500, 0, now() - interval '10 minutes', now() + interval '50 minutes', :'tech',  'PHOTOTEST'),
 ('a0000000-0000-0000-0000-000000000002', :'cust', 'Test Customer', 'cust@test.local', '09171234567', 'confirmed', 'paid',   'GCASH', 'Full', 500, 0, now() + interval '3 hours',    now() + interval '4 hours',    :'tech',  'PHOTOTEST'),
 ('a0000000-0000-0000-0000-000000000003', :'cust', 'Test Customer', 'cust@test.local', '09171234567', 'confirmed', 'paid',   'GCASH', 'Full', 500, 0, now() - interval '10 minutes', now() + interval '50 minutes', :'other', 'PHOTOTEST'),
 ('a0000000-0000-0000-0000-000000000004', :'cust', 'Test Customer', 'cust@test.local', '09171234567', 'confirmed', 'unpaid', 'GCASH', 'Full', 500, 500, now() - interval '10 minutes', now() + interval '50 minutes', :'tech', 'PHOTOTEST');

insert into public.booking_vehicles (id, booking_id, vehicle_type, brand, model, plate_number, status, staff_id)
values
 ('a0000001-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Sedan', 'Toyota', 'Vios', 'PHOTO01', 'SCHEDULED', :'tech'),
 ('a0000001-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'Sedan', 'Honda',  'City', 'PHOTO02', 'SCHEDULED', :'tech'),
 ('a0000001-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'Sedan', 'Mazda',  '3',    'PHOTO03', 'SCHEDULED', :'other'),
 ('a0000001-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', 'Sedan', 'Kia',    'Rio',  'PHOTO04', 'SCHEDULED', :'tech');

insert into public.payments (booking_id, amount, method, payment_type, status)
values
 ('a0000000-0000-0000-0000-000000000001', 500, 'GCash', 'Full', 'PAID'),
 ('a0000000-0000-0000-0000-000000000002', 500, 'GCash', 'Full', 'PAID'),
 ('a0000000-0000-0000-0000-000000000003', 500, 'GCash', 'Full', 'PAID');

-- the technician must be on duty for the staff screens
update public.profiles set is_clocked_in = true, clock_in_timestamp = now() where id = :'tech';

set session_replication_role = origin;

select b.id::text as booking, b.status, b.payment_status::text, (l.downpayment_met) as downpayment_met
  from public.bookings b left join public.booking_ledger_v l on l.booking_id = b.id
 where b.notes = 'PHOTOTEST' order by b.id;
