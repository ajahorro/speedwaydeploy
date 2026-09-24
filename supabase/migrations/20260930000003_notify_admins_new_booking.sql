-- ============================================================================
-- New-Booking Admin Notifications
-- ============================================================================
--
-- POLICY (decided with the studio owner):
--   * When a booking is created, ALL active admins receive an IN-APP
--     notification only (no email).
--   * CUSTOMERS receive their own booking updates in-app AND by email — that is
--     handled elsewhere (status lifecycle + confirmation emails); this trigger
--     deliberately does NOT create customer notifications for the creation event.
--   * STAFF receive NOTHING on creation — nothing is assigned to a bay yet.
--     Staff are notified only when a specific vehicle is assigned to them.
--
-- Implementation: an AFTER INSERT trigger on public.bookings fans out one
-- notification row per active ADMIN profile. Uses the existing notifications
-- schema (user_id, title, message, notification_type, action_url, is_read,
-- booking_id, entity_id). Idempotent and safe to re-run.
-- ============================================================================

create or replace function public.notify_admins_new_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_label text;
  v_amount text;
  v_title text;
  v_message text;
begin
  -- Human-readable customer label: the account name when present, otherwise the
  -- name captured on the booking itself (walk-in guests have no profile row).
  v_customer_label := coalesce(
    nullif(btrim(new.customer_name), ''),
    'A customer'
  );

  v_amount := to_char(coalesce(new.total_amount, 0), 'FM999,999,990.00');
  v_title := 'New Booking Received';
  v_message := v_customer_label || ' booked a service for ₱' || v_amount || '.';

  -- Fan out to every ACTIVE admin. Role comparison is case-insensitive so both
  -- 'ADMIN' and 'admin' rows are covered.
  insert into public.notifications (user_id, title, message, notification_type, is_read, booking_id, entity_id, action_url)
  select
    p.id,
    v_title,
    v_message,
    'NEW_BOOKING',
    false,
    new.id,
    new.id,
    '/admin/bookings/' || new.id
  from public.profiles p
  where upper(coalesce(p.role, '')) = 'ADMIN'
    and coalesce(p.is_active, true) = true;

  return new;
end;
$$;

comment on function public.notify_admins_new_booking() is
  'On booking creation, notify every active admin in-app (no email). Customers get their own in-app+email updates elsewhere; staff are notified on assignment only.';

drop trigger if exists trg_notify_admins_new_booking on public.bookings;
create trigger trg_notify_admins_new_booking
  after insert on public.bookings
  for each row
  execute function public.notify_admins_new_booking();

-- Helpful index for the notification bell / realtime feed queries.
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, is_read, created_at desc);

create index if not exists notifications_booking_id_idx
  on public.notifications (booking_id);