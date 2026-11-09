-- Clears the shop's records and keeps: accounts (sign-ins and profiles), customers' saved vehicles, shop settings and
-- services, staff shifts and attendance, audit logs, notifications and backups.
-- Run it once in the Supabase SQL editor. It cannot be undone, so take a backup first.
begin;

-- keep notifications and audit records, only unlink them from the bookings being removed
update public.notifications set booking_id = null where booking_id is not null;
update public.audit_logs set booking_id = null where booking_id is not null;
update public.audit_trails set booking_id = null where booking_id is not null;

-- every booking, with its vehicles, services, payments, receipts, refunds, chats, photos, emails and credit
delete from public.bookings;

-- records not tied to a booking
delete from public.booking_messages;
delete from public.booking_draft_invites;
delete from public.booking_drafts;
delete from public.customer_credit_ledger;
delete from public.ocr_scan_sessions;
delete from public.guest_inquiries;
delete from public.guest_registration_invites;
delete from public.test_bookings;
delete from public.support_reports;
delete from public.login_throttle;
delete from public.login_security_notices;

commit;
