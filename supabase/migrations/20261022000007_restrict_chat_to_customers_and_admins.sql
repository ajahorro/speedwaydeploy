-- Staff accounts must not read, send, update, or receive chat content.
create or replace function public.can_access_booking_message(
  p_customer_id uuid,
  p_sender_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles as me
     where me.id = auth.uid()
       and coalesce(me.is_active, true) = true
       and (
         upper(coalesce(me.role, '')) = 'ADMIN'
         or (
           upper(coalesce(me.role, '')) = 'CUSTOMER'
           and p_customer_id = me.id
         )
       )
  );
$$;

comment on function public.can_access_booking_message(uuid, uuid) is
  'Only active admins and the customer who owns a thread may access its messages. Staff and all other roles are excluded, including authors of historical messages.';

revoke all on function public.can_access_booking_message(uuid, uuid) from public, anon;
grant execute on function public.can_access_booking_message(uuid, uuid) to authenticated;

drop policy if exists "Participants can read their booking messages"
  on public.booking_messages;
create policy "Participants can read their booking messages"
  on public.booking_messages
  for select
  to authenticated
  using (public.can_access_booking_message(customer_id, sender_id));

drop policy if exists "Participants can send booking messages"
  on public.booking_messages;
create policy "Participants can send booking messages"
  on public.booking_messages
  for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and public.can_access_booking_message(customer_id, sender_id)
  );

drop policy if exists "Participants can update their booking messages"
  on public.booking_messages;
create policy "Participants can update their booking messages"
  on public.booking_messages
  for update
  to authenticated
  using (public.can_access_booking_message(customer_id, sender_id))
  with check (true);

-- Prevent any application path (including future notification dispatchers)
-- from creating chat-message notifications addressed to staff.
create or replace function public.reject_staff_chat_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    upper(coalesce(new.notification_type, '')) = 'MESSAGE_RECEIVED'
    or lower(coalesce(new.title, '')) like '%new message%'
  ) and exists (
    select 1
      from public.profiles as recipient
     where recipient.id = new.user_id
       and upper(coalesce(recipient.role, '')) = 'STAFF'
  ) then
    raise exception 'Chat message notifications cannot be sent to staff accounts.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_reject_staff_chat_notifications on public.notifications;
create trigger trg_reject_staff_chat_notifications
  before insert on public.notifications
  for each row
  execute function public.reject_staff_chat_notifications();

-- Hide any legacy message notifications from staff even if another permissive
-- notification SELECT policy grants users access to their own rows.
drop policy if exists "staff_cannot_read_chat_notifications" on public.notifications;
create policy "staff_cannot_read_chat_notifications"
  on public.notifications
  as restrictive
  for select
  to authenticated
  using (
    not (
      (
        upper(coalesce(notification_type, '')) = 'MESSAGE_RECEIVED'
        or lower(coalesce(title, '')) like '%new message%'
      )
      and exists (
        select 1
          from public.profiles as recipient
         where recipient.id = auth.uid()
           and upper(coalesce(recipient.role, '')) = 'STAFF'
      )
    )
  );
