-- ============================================================================
-- 1. A booking carries its customer's details; they follow the account while
--    the booking is open and freeze when it is finished.
--
--    bookings.customer_name / customer_first_name / customer_last_name /
--    contact_number / customer_email are the booking's own copy of who the
--    customer is. Every screen, email and receipt reads that copy, so:
--      * a new booking linked to an account is filled from the account;
--      * when the account's name, phone or email changes, every OPEN booking
--        (not completed, released, cancelled or flagged no-show) changes with it,
--        and each change is written to the audit log;
--      * a FINISHED booking is never touched again, so its receipt and history
--        keep showing the details it was served under.
--
-- 2. Walk-in customers get a registration invite (valid 7 days) in their emails.
--    It carries the details the admin entered so registration can pre-fill them.
--    Registering links the walk-in's bookings to the new account (existing
--    trigger), and the sync above then applies any name or phone the customer
--    corrected while registering.
-- ============================================================================

-- ── 1a. Fill the booking's copy from the account when it is created ─────────
create or replace function public.bookings_fill_customer_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.profiles%rowtype;
begin
  if new.customer_id is null then
    return new;
  end if;

  select * into p from public.profiles where id = new.customer_id;
  if not found then
    return new;
  end if;

  if nullif(btrim(coalesce(new.customer_name, '')), '') is null then
    new.customer_name := coalesce(
      nullif(btrim(coalesce(p.full_name, '')), ''),
      nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    );
  end if;
  if nullif(btrim(coalesce(new.customer_first_name, '')), '') is null then
    new.customer_first_name := nullif(btrim(coalesce(p.first_name, '')), '');
  end if;
  if nullif(btrim(coalesce(new.customer_last_name, '')), '') is null then
    new.customer_last_name := nullif(btrim(coalesce(p.last_name, '')), '');
  end if;
  if nullif(btrim(coalesce(new.contact_number, '')), '') is null then
    new.contact_number := nullif(btrim(coalesce(p.phone_number, '')), '');
  end if;
  if nullif(btrim(coalesce(new.customer_email, '')), '') is null then
    new.customer_email := nullif(btrim(coalesce(p.email, '')), '');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bookings_fill_customer_snapshot on public.bookings;
create trigger trg_bookings_fill_customer_snapshot
  before insert on public.bookings
  for each row execute function public.bookings_fill_customer_snapshot();

-- ── 1b. Account changes flow into open bookings ─────────────────────────────
create or replace function public.sync_profile_to_open_bookings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text;
  v_first text;
  v_last  text;
  v_phone text;
  v_email text;
  b record;
  v_changed text[];
begin
  if upper(coalesce(new.role::text, '')) <> 'CUSTOMER' then
    return new;
  end if;

  v_first := nullif(btrim(coalesce(new.first_name, '')), '');
  v_last  := nullif(btrim(coalesce(new.last_name, '')), '');
  v_name  := coalesce(
    nullif(btrim(coalesce(new.full_name, '')), ''),
    nullif(btrim(coalesce(v_first, '') || ' ' || coalesce(v_last, '')), '')
  );
  v_phone := nullif(btrim(coalesce(new.phone_number, '')), '');
  v_email := nullif(btrim(coalesce(new.email, '')), '');

  for b in
    select id, customer_name, customer_first_name, customer_last_name, contact_number, customer_email
      from public.bookings
     where customer_id = new.id
       and not public.booking_is_terminal(status)
  loop
    v_changed := '{}';
    if v_name is not null and b.customer_name is distinct from v_name then v_changed := array_append(v_changed, 'name'); end if;
    if v_phone is not null and b.contact_number is distinct from v_phone then v_changed := array_append(v_changed, 'phone'); end if;
    if v_email is not null and b.customer_email is distinct from v_email then v_changed := array_append(v_changed, 'email'); end if;

    if cardinality(v_changed) > 0 then
      update public.bookings
         set customer_name       = coalesce(v_name, customer_name),
             customer_first_name = coalesce(v_first, customer_first_name),
             customer_last_name  = coalesce(v_last, customer_last_name),
             contact_number      = coalesce(v_phone, contact_number),
             customer_email      = coalesce(v_email, customer_email),
             updated_at          = now()
       where id = b.id;

      insert into public.audit_logs (booking_id, action_type, details, actor_name, actor_role, actor_id, metadata)
      values (
        b.id,
        'CUSTOMER_DETAILS_UPDATED',
        'Customer details on this open booking were updated from the account (' || array_to_string(v_changed, ', ') || ').',
        'System',
        'SYSTEM',
        auth.uid(),
        jsonb_build_object(
          'changed', to_jsonb(v_changed),
          'old', jsonb_build_object('name', b.customer_name, 'phone', b.contact_number, 'email', b.customer_email),
          'new', jsonb_build_object('name', v_name, 'phone', v_phone, 'email', v_email)
        )
      );
    end if;
  end loop;

  return new;
end;
$$;

-- Named so it runs after trg_link_guest_bookings_to_customer (alphabetical),
-- which attaches a new account's walk-in bookings first.
drop trigger if exists trg_sync_profile_to_open_bookings on public.profiles;
create trigger trg_sync_profile_to_open_bookings
  after insert or update of first_name, last_name, full_name, phone_number, email on public.profiles
  for each row execute function public.sync_profile_to_open_bookings();

-- ── 1c. One-time backfill: linked bookings missing their copy ───────────────
update public.bookings b
   set customer_name = coalesce(
         nullif(btrim(coalesce(b.customer_name, '')), ''),
         nullif(btrim(coalesce(p.full_name, '')), ''),
         nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')),
       customer_first_name = coalesce(nullif(btrim(coalesce(b.customer_first_name, '')), ''), nullif(btrim(coalesce(p.first_name, '')), '')),
       customer_last_name  = coalesce(nullif(btrim(coalesce(b.customer_last_name, '')), ''), nullif(btrim(coalesce(p.last_name, '')), '')),
       contact_number      = coalesce(nullif(btrim(coalesce(b.contact_number, '')), ''), nullif(btrim(coalesce(p.phone_number, '')), '')),
       customer_email      = coalesce(nullif(btrim(coalesce(b.customer_email, '')), ''), nullif(btrim(coalesce(p.email, '')), ''))
  from public.profiles p
 where p.id = b.customer_id
   and (nullif(btrim(coalesce(b.customer_name, '')), '') is null
     or nullif(btrim(coalesce(b.contact_number, '')), '') is null
     or nullif(btrim(coalesce(b.customer_email, '')), '') is null);

-- ── 2. Walk-in registration invites ─────────────────────────────────────────
create table if not exists public.guest_registration_invites (
  token       text primary key,
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  email       text not null,
  first_name  text,
  last_name   text,
  phone       text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  used_at     timestamptz
);

create index if not exists guest_registration_invites_booking_idx
  on public.guest_registration_invites (booking_id);
create index if not exists guest_registration_invites_email_idx
  on public.guest_registration_invites (lower(email));

alter table public.guest_registration_invites enable row level security;
revoke all on public.guest_registration_invites from public, anon, authenticated;
grant all on public.guest_registration_invites to service_role;

-- Email side: one invite per booking, reused until it expires or is used.
create or replace function public.create_guest_registration_invite(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
  b public.bookings%rowtype;
  v_first text;
  v_last text;
  v_parts text[];
begin
  select * into b from public.bookings where id = p_booking_id;
  if not found or nullif(btrim(coalesce(b.customer_email, '')), '') is null then
    return null;
  end if;

  select token into v_token
    from public.guest_registration_invites
   where booking_id = p_booking_id and used_at is null and expires_at > now()
   order by created_at desc
   limit 1;
  if v_token is not null then
    return v_token;
  end if;

  v_first := nullif(btrim(coalesce(b.customer_first_name, '')), '');
  v_last := nullif(btrim(coalesce(b.customer_last_name, '')), '');
  if v_first is null then
    v_parts := regexp_split_to_array(btrim(coalesce(b.customer_name, '')), '\s+');
    v_first := nullif(v_parts[1], '');
    if v_last is null and array_length(v_parts, 1) > 1 then
      v_last := array_to_string(v_parts[2:array_length(v_parts, 1)], ' ');
    end if;
  end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.guest_registration_invites (token, booking_id, email, first_name, last_name, phone)
  values (v_token, p_booking_id, lower(btrim(b.customer_email)), v_first, v_last, nullif(btrim(coalesce(b.contact_number, '')), ''));
  return v_token;
end;
$$;
revoke all on function public.create_guest_registration_invite(uuid) from public, anon, authenticated;
grant execute on function public.create_guest_registration_invite(uuid) to service_role;

-- Registration page side: what the invite pre-fills. Returns nothing for an
-- unknown, expired or already-used token, and never the booking id.
create or replace function public.get_registration_invite(p_token text)
returns table (first_name text, last_name text, email text, phone text)
language sql
stable
security definer
set search_path = public
as $$
  select i.first_name, i.last_name, i.email, i.phone
    from public.guest_registration_invites i
   where i.token = p_token
     and i.used_at is null
     and i.expires_at > now()
   limit 1;
$$;
revoke all on function public.get_registration_invite(text) from public;
grant execute on function public.get_registration_invite(text) to anon, authenticated, service_role;

-- An invite is spent when its address registers.
create or replace function public.consume_registration_invites()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(btrim(coalesce(new.email, '')), '') is not null then
    update public.guest_registration_invites
       set used_at = now()
     where lower(email) = lower(btrim(new.email)) and used_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_consume_registration_invites on public.profiles;
create trigger trg_consume_registration_invites
  after insert on public.profiles
  for each row execute function public.consume_registration_invites();
