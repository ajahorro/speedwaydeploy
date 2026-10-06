-- An invitation nobody taps goes away quietly after 2 minutes: it can no longer be used, and its chat message is
-- removed together with older replaced or ignored ones. Once the customer has sent their details the shop still has 24
-- hours to open them (unchanged).
create or replace function public.send_booking_draft_invite(p_customer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invite uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an administrator can send this invitation.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_customer_id and upper(p.role) = 'CUSTOMER' and coalesce(p.is_active, true)) then
    raise exception 'The customer needs an active account.' using errcode = '23514';
  end if;

  update public.booking_draft_invites set status = 'CANCELLED'
   where customer_id = p_customer_id and status in ('SENT', 'SHARED');

  -- old invitations that were replaced or ignored disappear from the chat
  delete from public.booking_messages
   where invite_id in (
     select id from public.booking_draft_invites
      where customer_id = p_customer_id and draft is null
        and (status = 'CANCELLED' or (status = 'SENT' and expires_at <= now())));

  insert into public.booking_draft_invites (customer_id, created_by, expires_at)
  values (p_customer_id, auth.uid(), now() + interval '2 minutes')
  returning id into v_invite;

  insert into public.booking_messages (customer_id, sender_id, message, message_type, is_read, invite_id)
  values (p_customer_id, auth.uid(),
          'Please send us your saved booking details so we can book for you. Tap the button below.',
          'booking_invite', false, v_invite);
  return v_invite;
end;
$fn$;
