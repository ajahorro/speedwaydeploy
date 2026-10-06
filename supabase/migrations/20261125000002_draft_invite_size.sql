-- "Send my booking details" failed for every customer who had reached the payment step: the saved booking carried the
-- shop's QR code image (about 280 KB, rebuilt anyway when the payment page opens), which is over the 200 KB limit, so
-- the booking details were refused. The image is not booking data: it is dropped from what is shared, and the size
-- limit is checked on what remains.
create or replace function public.share_booking_draft(p_invite_id uuid, p_data jsonb, p_step integer default 1)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invite public.booking_draft_invites%rowtype;
  v_clean jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in to send your booking details.' using errcode = '42501';
  end if;
  select * into v_invite from public.booking_draft_invites where id = p_invite_id for update;
  if not found or v_invite.customer_id <> auth.uid() then
    raise exception 'This invitation was not found.' using errcode = '42501';
  end if;
  if v_invite.status <> 'SENT' or v_invite.expires_at <= now() then
    raise exception 'This invitation is no longer open. Ask the shop for a new one.' using errcode = '23514';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'The booking details could not be sent.' using errcode = '22023';
  end if;
  v_clean := p_data - 'payment' - '__extras' - 'qrSnapshot';
  if octet_length(v_clean::text) > 200000 then
    raise exception 'The booking details could not be sent.' using errcode = '22023';
  end if;

  update public.booking_draft_invites
     set status = 'SHARED', draft = v_clean, draft_step = least(greatest(coalesce(p_step, 1), 1), 4),
         shared_at = now(), expires_at = now() + interval '24 hours'
   where id = p_invite_id;

  insert into public.booking_messages (customer_id, sender_id, message, message_type, is_read)
  values (auth.uid(), auth.uid(), 'I sent my booking details.', 'text', false);
end;
$fn$;
