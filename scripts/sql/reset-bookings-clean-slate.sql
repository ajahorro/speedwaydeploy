-- ============================================================================
-- RESET: delete every booking and everything that hangs off it.
--
-- KEEPS: accounts (auth.users, profiles), customer garage vehicles and fleet
--        groups, staff shifts, business configuration (business_config,
--        blocked_slots, services/promos), system broadcasts, and audit
--        entries that are not about bookings or payments (invites, logins,
--        account and settings changes).
--
-- DELETES: bookings, booking vehicles and service lines, payments, refunds and
--          refund allocations, the customer credit ledger, OCR scan sessions,
--          service photo records, booking/chat messages, booking email
--          delivery records, booking events, booking/payment notifications,
--          booking/payment audit entries, the test_bookings sandbox, and
--          OPTIONAL photo/receipt/chat files in storage (section 4).
--
-- THIS CANNOT BE UNDONE. Take a backup first (Supabase Dashboard > Database >
-- Backups, or `supabase db dump --linked --data-only -f backup.sql`).
--
-- HOW TO RUN: Supabase Dashboard > SQL Editor > paste this whole file > Run.
-- It runs in one transaction: if any statement fails, nothing is deleted.
-- ============================================================================

begin;

-- ── 1. Preview (what is about to be removed) ────────────────────────────────
select 'bookings' as table_name, count(*) as rows_to_delete from public.bookings
union all select 'payments', count(*) from public.payments
union all select 'booking_vehicles', count(*) from public.booking_vehicles
union all select 'service_photos', count(*) from public.service_photos
union all select 'booking_messages (chat)', count(*) from public.booking_messages
union all select 'customer_credit_ledger', count(*) from public.customer_credit_ledger
union all select 'notifications (booking/payment)', count(*) from public.notifications
  where booking_id is not null
     or upper(coalesce(notification_type, '')) similar to '%(BOOKING|PAYMENT|REFUND|TASK|SERVICE|CHAT|NOSHOW|NO_SHOW|RECEIPT)%'
union all select 'audit_logs (booking/payment)', count(*) from public.audit_logs
  where booking_id is not null
     or (metadata ? 'payment_id') or (metadata ? 'booking_id')
     or upper(coalesce(action_type, '')) similar to '%(BOOKING|PAYMENT|REFUND|RESCHEDUL|NOSHOW|NO_SHOW|OVERRIDE|TASK|ASSIGN|RELEASE|CANCEL)%';

-- ── 2. Delete bookings and dependents ───────────────────────────────────────
-- Rows that do NOT cascade from bookings (their FK is ON DELETE SET NULL, or
-- they hang off payments) are removed explicitly first.
delete from public.payment_refund_allocations;
delete from public.ocr_scan_sessions;
delete from public.customer_credit_ledger;

-- Chat: threads are per customer but every message is booking support traffic.
delete from public.booking_messages;

-- Cascades to booking_vehicles -> booking_vehicle_services, payments,
-- service_photos, booking_email_deliveries, booking_events,
-- email_sent_statuses, and booking-linked notifications/audit_logs.
delete from public.bookings;

delete from public.test_bookings;

-- ── 3. Clean up rows written by triggers during the deletes, and booking /
--       payment rows that carried no booking_id ─────────────────────────────
delete from public.customer_credit_ledger;   -- credit reconciliation may re-insert during payment deletes

delete from public.notifications
 where booking_id is not null
    or upper(coalesce(notification_type, '')) similar to '%(BOOKING|PAYMENT|REFUND|TASK|SERVICE|CHAT|NOSHOW|NO_SHOW|RECEIPT)%';

delete from public.audit_logs
 where booking_id is not null
    or (metadata ? 'payment_id') or (metadata ? 'booking_id')
    or upper(coalesce(action_type, '')) similar to '%(BOOKING|PAYMENT|REFUND|RESCHEDUL|NOSHOW|NO_SHOW|OVERRIDE|TASK|ASSIGN|RELEASE|CANCEL)%';

delete from public.audit_trails
 where table_name in ('bookings', 'payments', 'booking_vehicles', 'booking_vehicle_services',
                      'service_photos', 'booking_messages', 'customer_credit_ledger',
                      'payment_refund_allocations', 'notifications');

-- ── 4. OPTIONAL: storage files (photos, receipts, chat attachments) ─────────
-- Database rows above are gone, but the uploaded FILES stay in Storage until
-- removed. Supabase blocks deleting storage.objects with SQL, so empty these
-- buckets from Dashboard > Storage instead:
--   service-proofs   (before/after service photos)
--   payment-receipts (customer receipt images)
--   chat_media       (chat attachments)

-- ── 5. Verify, then commit ──────────────────────────────────────────────────
select 'bookings' as table_name, count(*) as rows_left from public.bookings
union all select 'payments', count(*) from public.payments
union all select 'booking_vehicles', count(*) from public.booking_vehicles
union all select 'booking_vehicle_services', count(*) from public.booking_vehicle_services
union all select 'service_photos', count(*) from public.service_photos
union all select 'booking_messages', count(*) from public.booking_messages
union all select 'customer_credit_ledger', count(*) from public.customer_credit_ledger
union all select 'payment_refund_allocations', count(*) from public.payment_refund_allocations
union all select 'ocr_scan_sessions', count(*) from public.ocr_scan_sessions
union all select 'booking_email_deliveries', count(*) from public.booking_email_deliveries
union all select 'profiles (kept)', count(*) from public.profiles;

commit;
