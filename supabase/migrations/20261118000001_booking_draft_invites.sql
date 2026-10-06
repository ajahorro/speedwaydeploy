-- ============================================================================
-- "Book for customer", from the chat.
--
--   1. The administrator sends a customer (with an account) an invitation in the chat.
--   2. The customer taps it and, if they have an unfinished booking saved, sends it to the shop. That copy is
--      readable only by the administrators and that customer, valid for 24 hours, and used once.
--   3. The administrator opens "Book for customer": the walk-in form fills in with those details and the
--      customer's account (the app does that part, using the booking details returned here).
--   The receipt photo is handed over by the customer separately and the administrator submits it in the form.
-- ============================================================================
create table if not exists public.booking_draft_invites (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  status text not null default 'SENT' check (status in ('SENT', 'SHARED', 'USED', 'CANCELLED')),
  draft jsonb,
  draft_step integer,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  shared_at timestamptz,
  used_at timestamptz
);
create index if not exists booking_draft_invites_customer_idx on public.booking_draft_invites (customer_id, created_at desc);

alter table public.booking_draft_invites enable row level security;
revoke all on public.booking_draft_invites from anon, authenticated;
grant select on public.booking_draft_invites to authenticated;
drop policy if exists booking_draft_invites_select on public.booking_draft_invites;
create policy booking_draft_invites_select on public.booking_draft_invites
  for select to authenticated
  using (customer_id = (select auth.uid()) or public.is_admin());

alter table public.booking_messages add column if not exists invite_id uuid references public.booking_draft_invites(id) on delete set null;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'booking_draft_invites') then
    alter publication supabase_realtime add table public.booking_draft_invites;
  end if;
end $$;

-- 1. the administrator invites a customer
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

  insert into public.booking_draft_invites (customer_id, created_by)
  values (p_customer_id, auth.uid())
  returning id into v_invite;

  insert into public.booking_messages (customer_id, sender_id, message, message_type, is_read, invite_id)
  values (p_customer_id, auth.uid(),
          'Please send us your saved booking details so we can book for you. Tap the button below.',
          'booking_invite', false, v_invite);
  return v_invite;
end;
$fn$;

-- 2. the customer sends their saved booking details
create or replace function public.share_booking_draft(p_invite_id uuid, p_data jsonb, p_step integer default 1)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invite public.booking_draft_invites%rowtype;
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
  if p_data is null or jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 200000 then
    raise exception 'The booking details could not be sent.' using errcode = '22023';
  end if;

  update public.booking_draft_invites
     set status = 'SHARED', draft = p_data - 'payment' - '__extras', draft_step = least(greatest(coalesce(p_step, 1), 1), 4),
         shared_at = now(), expires_at = now() + interval '24 hours'
   where id = p_invite_id;

  insert into public.booking_messages (customer_id, sender_id, message, message_type, is_read)
  values (auth.uid(), auth.uid(), 'I sent my booking details.', 'text', false);
end;
$fn$;

-- 3. the administrator opens the details (once)
create or replace function public.use_booking_draft_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invite public.booking_draft_invites%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an administrator can open these details.' using errcode = '42501';
  end if;
  select * into v_invite from public.booking_draft_invites where id = p_invite_id for update;
  if not found then
    raise exception 'This invitation was not found.' using errcode = 'P0002';
  end if;
  if v_invite.status <> 'SHARED' or v_invite.expires_at <= now() or v_invite.draft is null then
    raise exception 'The customer has not sent their details, or they have expired.' using errcode = '23514';
  end if;
  update public.booking_draft_invites set status = 'USED', used_at = now() where id = p_invite_id;
  return jsonb_build_object('customer_id', v_invite.customer_id, 'data', v_invite.draft, 'step', v_invite.draft_step);
end;
$fn$;

revoke all on function public.send_booking_draft_invite(uuid), public.share_booking_draft(uuid, jsonb, integer), public.use_booking_draft_invite(uuid) from public, anon;
grant execute on function public.send_booking_draft_invite(uuid), public.share_booking_draft(uuid, jsonb, integer), public.use_booking_draft_invite(uuid) to authenticated;
