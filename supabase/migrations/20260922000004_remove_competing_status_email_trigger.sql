-- Lifecycle email and in-app notification dispatch is performed explicitly by the
-- backend status propagator and the shared send-status-email function.
-- Remove the legacy database trigger so one status change cannot dispatch twice.
drop trigger if exists on_booking_status_change on public.bookings;
