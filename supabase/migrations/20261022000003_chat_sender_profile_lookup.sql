create or replace function public.get_chat_sender_profiles(
  p_customer_id uuid,
  p_sender_ids uuid[]
)
returns table (
  id uuid,
  full_name text,
  first_name text,
  last_name text,
  role text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean := false;
begin
  if v_user_id is null or p_customer_id is null then
    raise exception 'Authenticated customer thread is required';
  end if;

  select exists (
    select 1 from public.profiles
     where profiles.id = v_user_id
       and upper(coalesce(profiles.role, '')) = 'ADMIN'
  ) into v_is_admin;

  if not v_is_admin and v_user_id <> p_customer_id then
    raise exception 'Only the customer or an administrator can resolve this thread';
  end if;

  return query
  select sender.id, sender.full_name, sender.first_name, sender.last_name, sender.role
    from public.profiles as sender
   where sender.id = any(coalesce(p_sender_ids, array[]::uuid[]))
     and (
       v_is_admin
       or sender.id = p_customer_id
       or (
         upper(coalesce(sender.role, '')) = 'ADMIN'
         and exists (
           select 1 from public.booking_messages as message
            where message.customer_id = p_customer_id
              and message.sender_id = sender.id
         )
       )
     );
end;
$$;

revoke all on function public.get_chat_sender_profiles(uuid, uuid[]) from public, anon;
grant execute on function public.get_chat_sender_profiles(uuid, uuid[]) to authenticated;