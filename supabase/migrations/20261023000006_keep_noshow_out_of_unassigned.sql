alter table public.bookings
  add column if not exists was_flagged_no_show boolean not null default false;

update public.bookings b
   set was_flagged_no_show = true
 where not b.was_flagged_no_show
   and (
     upper(coalesce(b.status::text, '')) in ('FLAGGED_NOSHOW', 'NO_SHOW')
     or coalesce(b.cancellation_reason, '') ilike '%no-show%'
     or exists (
       select 1
         from public.audit_logs a
        where a.booking_id = b.id
          and upper(coalesce(a.action_type, '')) in ('SYSTEM_FLAG_NOSHOW', 'UNDO_NO_SHOW')
     )
   );

create or replace function public.preserve_no_show_booking_marker()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if upper(coalesce(new.status::text, '')) in ('FLAGGED_NOSHOW', 'NO_SHOW') then
    new.was_flagged_no_show := true;
  elsif tg_op = 'UPDATE' and coalesce(old.was_flagged_no_show, false) then
    new.was_flagged_no_show := true;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_preserve_no_show_booking_marker on public.bookings;
create trigger trg_preserve_no_show_booking_marker
  before insert or update on public.bookings
  for each row
  execute function public.preserve_no_show_booking_marker();

comment on column public.bookings.was_flagged_no_show is
  'Persistent marker for bookings that have entered the no-show lifecycle, including bookings later restored or cancelled.';
