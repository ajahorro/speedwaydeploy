create or replace function public.suppress_unlinked_booking_notifications()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if upper(coalesce(new.notification_type, '')) in (
    'CHAT_MESSAGE',
    'MESSAGE_RECEIVED',
    'STATUS_UPDATE'
  ) and new.booking_id is null then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists suppress_unlinked_booking_notifications on public.notifications;
create trigger suppress_unlinked_booking_notifications
before insert on public.notifications
for each row
execute function public.suppress_unlinked_booking_notifications();
