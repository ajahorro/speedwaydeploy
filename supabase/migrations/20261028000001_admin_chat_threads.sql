-- ============================================================================
-- One thread list for every admin chat surface.
--
-- A conversation belongs to a CUSTOMER (booking_messages.customer_id); a
-- message may carry a booking tag (booking_messages.booking_id) like a ticket
-- reference. The floating chat bubble and the admin Chat page both list
-- conversations from this function, so they can never disagree about which
-- threads exist, what the last message was, or how many are unread.
--
-- Unread = messages the signed-in admin did not send and nobody has opened.
-- (Opening a thread marks it read for everyone, so this is shared state.)
-- ============================================================================
create or replace function public.admin_chat_threads()
returns table (
  customer_id uuid,
  customer_name text,
  customer_email text,
  last_message text,
  last_message_type text,
  last_message_at timestamptz,
  last_sender_id uuid,
  last_booking_id uuid,
  unread_count bigint,
  booking_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  return query
  with msgs as (
    select m.customer_id, m.booking_id, m.sender_id, m.is_read, m.created_at, m.message_type,
           coalesce(nullif(m.message_text, ''), m.message) as body
      from public.booking_messages m
     where m.customer_id is not null
       and m.message_type is distinct from 'system'
  ),
  latest as (
    select distinct on (msgs.customer_id)
           msgs.customer_id, msgs.body, msgs.message_type, msgs.created_at, msgs.sender_id, msgs.booking_id
      from msgs
     order by msgs.customer_id, msgs.created_at desc
  ),
  unread as (
    select msgs.customer_id, count(*) as n
      from msgs
     where not coalesce(msgs.is_read, false)
       and msgs.sender_id is distinct from auth.uid()
     group by msgs.customer_id
  ),
  tagged as (
    select s.customer_id, array_agg(s.booking_id order by s.last_at desc) as ids
      from (
        select msgs.customer_id, msgs.booking_id, max(msgs.created_at) as last_at
          from msgs
         where msgs.booking_id is not null
         group by msgs.customer_id, msgs.booking_id
      ) s
     group by s.customer_id
  )
  select l.customer_id,
         coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.email, 'Customer'),
         p.email,
         l.body,
         l.message_type,
         l.created_at,
         l.sender_id,
         l.booking_id,
         coalesce(u.n, 0),
         coalesce(t.ids, '{}'::uuid[])
    from latest l
    left join public.profiles p on p.id = l.customer_id
    left join unread u on u.customer_id = l.customer_id
    left join tagged t on t.customer_id = l.customer_id
   order by l.created_at desc;
end;
$$;

revoke all on function public.admin_chat_threads() from public, anon;
grant execute on function public.admin_chat_threads() to authenticated, service_role;
