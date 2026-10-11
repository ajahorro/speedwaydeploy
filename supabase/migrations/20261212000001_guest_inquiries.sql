-- Guest inquiries: questions sent from the landing page contact form by people with no account.
-- One thread per e-mail address. The shop's administrators read and answer them in Message Inquiries; every answer
-- is e-mailed to the address the person gave. Only the server (service account) writes; administrators read.

create table if not exists public.guest_inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create unique index if not exists guest_inquiries_email_idx on public.guest_inquiries (lower(email));

create table if not exists public.guest_inquiry_messages (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.guest_inquiries(id) on delete cascade,
  sender text not null check (sender in ('guest', 'admin')),
  body text not null check (char_length(body) between 1 and 4000),
  admin_id uuid references public.profiles(id) on delete set null,
  read_by_admin boolean not null default false,
  emailed_at timestamptz,
  email_error text,
  created_at timestamptz not null default now()
);
create index if not exists guest_inquiry_messages_thread_idx on public.guest_inquiry_messages (inquiry_id, created_at);

alter table public.guest_inquiries enable row level security;
alter table public.guest_inquiry_messages enable row level security;
revoke all on public.guest_inquiries, public.guest_inquiry_messages from anon, authenticated;
grant select on public.guest_inquiries, public.guest_inquiry_messages to authenticated;
grant all on public.guest_inquiries, public.guest_inquiry_messages to service_role;

drop policy if exists guest_inquiries_admin_read on public.guest_inquiries;
create policy guest_inquiries_admin_read on public.guest_inquiries for select to authenticated using ((select public.is_admin()));
drop policy if exists guest_inquiry_messages_admin_read on public.guest_inquiry_messages;
create policy guest_inquiry_messages_admin_read on public.guest_inquiry_messages for select to authenticated using ((select public.is_admin()));

-- the conversation list: one row per guest with the latest message and how many guest messages are unread
create or replace function public.admin_guest_inquiry_threads()
returns table (inquiry_id uuid, name text, email text, last_message text, last_message_at timestamptz, last_sender text, unread_count integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  return query
  select i.id, i.name, i.email, lm.body, i.last_message_at, lm.sender,
         (select count(*)::integer from public.guest_inquiry_messages m where m.inquiry_id = i.id and m.sender = 'guest' and not m.read_by_admin)
    from public.guest_inquiries i
    left join lateral (select m.body, m.sender from public.guest_inquiry_messages m where m.inquiry_id = i.id order by m.created_at desc limit 1) lm on true
   order by i.last_message_at desc;
end;
$$;
revoke all on function public.admin_guest_inquiry_threads() from public, anon;
grant execute on function public.admin_guest_inquiry_threads() to authenticated;

create or replace function public.mark_guest_inquiry_read(p_inquiry uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  update public.guest_inquiry_messages set read_by_admin = true where inquiry_id = p_inquiry and sender = 'guest' and not read_by_admin;
end;
$$;
revoke all on function public.mark_guest_inquiry_read(uuid) from public, anon;
grant execute on function public.mark_guest_inquiry_read(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.guest_inquiry_messages; exception when duplicate_object then null; end;
  end if;
end $$;
