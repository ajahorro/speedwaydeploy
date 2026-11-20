-- "Book for customer" (booking_draft_invites, 20261118000001) marks an invite USED the moment the
-- administrator OPENS the customer's shared details into the walk-in wizard — not once a booking
-- actually comes out of it. Nothing then clears the customer's own saved draft (booking_drafts,
-- kind='customer'), so after the admin finishes the booking the customer can still come back to
-- "Book an Appointment" and be offered a "resume your draft?" for a booking that already exists —
-- confusing, and easy to mistake for still needing to do something.
--
-- booking_id is set only once the walk-in booking is actually created, which is the signal both
-- sides need: the customer's own chat card uses it to know the details were truly acted on (not
-- just opened) and clears their stray draft then; the admin side already clears its own
-- 'admin_walkin' draft on submit (CustomerBookAppointment.jsx).
alter table public.booking_draft_invites add column if not exists booking_id uuid references public.bookings(id) on delete set null;

create or replace function public.complete_booking_draft_invite(p_invite_id uuid, p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invite public.booking_draft_invites%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an administrator can complete this invitation.' using errcode = '42501';
  end if;
  select * into v_invite from public.booking_draft_invites where id = p_invite_id for update;
  if not found or v_invite.status <> 'USED' then
    return; -- nothing to complete (already cancelled/replaced, or never opened); not worth failing the booking over
  end if;

  update public.booking_draft_invites set booking_id = p_booking_id where id = p_invite_id;
  -- Bypasses booking_drafts' owner-only RLS: the customer's own stray draft is now stale, not theirs to keep.
  delete from public.booking_drafts where user_id = v_invite.customer_id and kind = 'customer';
end;
$fn$;

revoke all on function public.complete_booking_draft_invite(uuid, uuid) from public, anon;
grant execute on function public.complete_booking_draft_invite(uuid, uuid) to authenticated;
