-- ============================================================================
-- Every record that exists because of a booking now goes when the booking goes.
--
-- Found while writing the clean-slate reset: several booking-derived rows did
-- not follow their booking, because they were either never linked to it or
-- linked with ON DELETE SET NULL.
--
-- 1. Five notification triggers that were added in the dashboard (no migration
--    created them) wrote notifications WITHOUT a booking_id:
--      bookings          tr_notify_on_booking_status_change  ("Booking Updated"
--                        on EVERY row update, linking to /dashboard)
--      bookings          trg_notify_technician_assignment    (unlinked
--                        "assignment" notice the stale-assignment revoker
--                        cannot see; the frontend already hides it)
--      booking_messages  tr_notify_on_booking_message, trg_chat_notification,
--                        trigger_new_chat_message (three notifications per
--                        message, including to STAFF, which the chat policy
--                        forbids; one looks up role 'admin' in lower case and
--                        links customers to a non-existent /my-bookings route)
--    The app already sends these notifications itself, linked to the booking:
--    chat via BookingChat/eventEngine (customer + admins), staff task alerts
--    only via the payment-gated reconciler, and status/payment notices via the
--    booking-lifecycle function. The duplicate triggers are retired and the
--    orphan rows they wrote are removed.
--
-- 2. customer_credit_ledger.booking_id and ocr_scan_sessions.booking_id /
--    payment_id were ON DELETE SET NULL, leaving credit entries and scan
--    sessions behind with no booking. They now cascade.
--
-- 3. audit_trails (full row copies written by process_audit_log, also added
--    in the dashboard) had no booking link at all. It now carries booking_id
--    with ON DELETE CASCADE, and the trigger no longer writes a copy for a
--    booking that is being deleted (its history is deleted with it).
-- ============================================================================

-- ── 1. Retire the duplicate, unlinked notification triggers ─────────────────
drop trigger if exists tr_notify_on_booking_status_change on public.bookings;
drop trigger if exists trg_notify_technician_assignment on public.bookings;
drop trigger if exists tr_notify_on_booking_message on public.booking_messages;
drop trigger if exists trg_chat_notification on public.booking_messages;
drop trigger if exists trigger_new_chat_message on public.booking_messages;

drop function if exists public.notify_on_booking_status_change();
drop function if exists public.notify_technician_assignment();
drop function if exists public.notify_on_booking_message();
drop function if exists public.handle_chat_notification();
drop function if exists public.handle_new_chat_notification();

-- Rows those triggers wrote. Their types are lower case; the application's own
-- notification types are upper case (STATUS_UPDATE, TASK_ASSIGNED,
-- MESSAGE_RECEIVED), so this does not touch app-created notifications.
delete from public.notifications
 where notification_type in ('status_update', 'assignment', 'chat_message');

-- ── 2. Credit entries and OCR scan sessions follow their booking / payment ──
alter table public.customer_credit_ledger
  drop constraint if exists customer_credit_ledger_booking_id_fkey,
  add constraint customer_credit_ledger_booking_id_fkey
    foreign key (booking_id) references public.bookings(id) on delete cascade;

alter table public.ocr_scan_sessions
  drop constraint if exists ocr_scan_sessions_booking_id_fkey,
  add constraint ocr_scan_sessions_booking_id_fkey
    foreign key (booking_id) references public.bookings(id) on delete cascade,
  drop constraint if exists ocr_scan_sessions_payment_id_fkey,
  add constraint ocr_scan_sessions_payment_id_fkey
    foreign key (payment_id) references public.payments(id) on delete cascade;

-- ── 3. audit_trails belongs to its booking ──────────────────────────────────
alter table public.audit_trails add column if not exists booking_id uuid;

update public.audit_trails t
   set booking_id = case
     when t.table_name = 'bookings' then t.record_id
     else nullif(coalesce(t.new_data ->> 'booking_id', t.old_data ->> 'booking_id'), '')::uuid
   end
 where t.booking_id is null
   and t.table_name in ('bookings', 'payments');

-- History of bookings that no longer exist (already orphaned).
delete from public.audit_trails t
 where t.booking_id is not null
   and not exists (select 1 from public.bookings b where b.id = t.booking_id);

alter table public.audit_trails
  drop constraint if exists audit_trails_booking_id_fkey,
  add constraint audit_trails_booking_id_fkey
    foreign key (booking_id) references public.bookings(id) on delete cascade;

create index if not exists audit_trails_booking_id_idx on public.audit_trails (booking_id);

create or replace function public.process_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_booking_id uuid := case
    when tg_table_name = 'bookings' then (v_row ->> 'id')::uuid
    else nullif(v_row ->> 'booking_id', '')::uuid
  end;
begin
  -- A booking being deleted takes its history with it: do not write a copy
  -- for the booking itself or for rows cascading from it.
  if tg_op = 'DELETE'
     and v_booking_id is not null
     and not exists (select 1 from public.bookings where id = v_booking_id) then
    return old;
  end if;

  if tg_op = 'DELETE' then
    insert into public.audit_trails (table_name, record_id, action_type, old_data, actor_id, booking_id)
    values (tg_table_name, old.id, 'DELETE', row_to_json(old), current_user_id, v_booking_id);
    return old;
  elsif tg_op = 'UPDATE' then
    insert into public.audit_trails (table_name, record_id, action_type, old_data, new_data, actor_id, booking_id)
    values (tg_table_name, new.id, 'UPDATE', row_to_json(old), row_to_json(new), current_user_id, v_booking_id);
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.audit_trails (table_name, record_id, action_type, new_data, actor_id, booking_id)
    values (tg_table_name, new.id, 'INSERT', row_to_json(new), current_user_id, v_booking_id);
    return new;
  end if;
  return null;
end;
$$;
