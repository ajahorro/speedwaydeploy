-- "Recent sign-ins" in Settings: the signed-in user's own active sessions (device, address, when), newest first.
create or replace function public.my_sign_ins()
returns table (signed_in_at timestamptz, last_active timestamptz, device text, ip text, is_current boolean)
language sql security definer set search_path = public, auth stable as $$
  select s.created_at, coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at),
         left(coalesce(s.user_agent, ''), 300), host(s.ip),
         s.id::text = coalesce(auth.jwt() ->> 'session_id', '')
    from auth.sessions s
   where s.user_id = auth.uid() and (s.not_after is null or s.not_after > now())
   order by 2 desc
   limit 20
$$;
revoke all on function public.my_sign_ins() from public, anon;
grant execute on function public.my_sign_ins() to authenticated;
