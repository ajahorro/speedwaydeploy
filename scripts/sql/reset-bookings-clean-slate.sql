-- ============================================================================
-- RESET: delete every booking. Everything that belongs to a booking is removed
-- by the database automatically (ON DELETE CASCADE), so this script does not
-- need to know about each related table.
--
-- Requires migration 20261025000003_link_booking_side_records.sql, which made
-- every booking-derived record follow its booking:
--   booking vehicles and service lines, payments (and refund allocations),
--   customer credit entries, OCR scan sessions, service photo records,
--   booking-tagged chat messages, booking notifications, booking audit logs,
--   booking change history (audit_trails), email delivery records, events.
--
-- KEEPS: accounts and profiles, garage vehicles and fleet groups, staff shifts,
--        Business Hub configuration, announcements, non-booking audit history,
--        and customer chat messages that were not tagged to a booking.
--
-- THIS CANNOT BE UNDONE. Take a backup first (Supabase Dashboard > Database >
-- Backups). Run it in Dashboard > SQL Editor; it is one transaction, so if
-- anything fails nothing is deleted.
-- ============================================================================

begin;

-- Preview
select 'bookings' as table_name, count(*) as rows_to_delete from public.bookings
union all select 'payments', count(*) from public.payments
union all select 'booking_vehicles', count(*) from public.booking_vehicles
union all select 'customer_credit_ledger (booking entries)', count(*) from public.customer_credit_ledger where booking_id is not null
union all select 'notifications (booking)', count(*) from public.notifications where booking_id is not null
union all select 'audit_logs (booking)', count(*) from public.audit_logs where booking_id is not null;

-- The one statement that matters: related records cascade.
delete from public.bookings;

-- The pricing sandbox table is not linked to real bookings.
delete from public.test_bookings;

-- OPTIONAL: also clear customer chat threads that were not tagged to a
-- booking. Uncomment to start chat from zero too.
-- delete from public.booking_messages;

-- Verify (all zero except profiles)
select 'bookings' as table_name, count(*) as rows_left from public.bookings
union all select 'payments', count(*) from public.payments
union all select 'booking_vehicles', count(*) from public.booking_vehicles
union all select 'booking_vehicle_services', count(*) from public.booking_vehicle_services
union all select 'service_photos', count(*) from public.service_photos
union all select 'customer_credit_ledger (booking entries)', count(*) from public.customer_credit_ledger where booking_id is not null
union all select 'ocr_scan_sessions (booking)', count(*) from public.ocr_scan_sessions where booking_id is not null
union all select 'notifications (booking)', count(*) from public.notifications where booking_id is not null
union all select 'audit_logs (booking)', count(*) from public.audit_logs where booking_id is not null
union all select 'audit_trails (booking)', count(*) from public.audit_trails where booking_id is not null
union all select 'profiles (kept)', count(*) from public.profiles;

commit;

-- Uploaded files (service photos, payment receipts, chat attachments) live in
-- Storage, which SQL cannot delete. Empty the service-proofs, payment-receipts
-- and chat_media buckets from Dashboard > Storage if you want those gone too.
