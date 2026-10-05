-- ============================================================================
-- 1. Promo codes
--
-- A promo CODE is a promotion a customer must type in on the last booking page.
-- Codes are kept in their own admin-only table (not in the public Business Hub
-- configuration, which every visitor can read) so the list of codes is not
-- public. A customer redeems one code at a time through redeem_promo_code(),
-- which returns that promotion's rule if the code is currently valid.
--
-- The booking records the code that was used, and the database re-checks the
-- code when the booking is created (valid, in its dates, not used up) and counts
-- the use, so a stale or tampered browser cannot bypass it.
-- ============================================================================
create table if not exists public.promo_codes (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,
  name          text not null,
  discount_type text not null check (discount_type in ('percentage', 'fixed')),
  discount_value numeric not null check (discount_value > 0),
  vehicle_types text[] not null default '{}',      -- empty = every vehicle type
  service_names text[] not null default '{}',      -- empty = every service
  valid_from    timestamptz,
  valid_until   timestamptz,                       -- null = never expires
  max_uses      integer check (max_uses is null or max_uses > 0),
  uses_count    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint promo_codes_percentage_range check (discount_type <> 'percentage' or discount_value <= 100)
);

create unique index if not exists promo_codes_code_unique on public.promo_codes (lower(btrim(code)));

alter table public.promo_codes enable row level security;
revoke all on public.promo_codes from anon;

create policy promo_codes_admin_all on public.promo_codes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create or replace function public.promo_codes_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  new.code := upper(btrim(new.code));
  return new;
end;
$$;

create trigger trg_promo_codes_touch
  before insert or update on public.promo_codes
  for each row execute function public.promo_codes_touch();

alter table public.bookings add column if not exists promo_code text;

-- The one validity rule, shared by the customer lookup and the booking check.
create or replace function public.promo_code_status(p_code text)
returns table (id uuid, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r public.promo_codes%rowtype;
  v_code text := lower(btrim(coalesce(p_code, '')));
begin
  if v_code = '' then
    return query select null::uuid, 'empty'::text; return;
  end if;
  select * into r from public.promo_codes where lower(btrim(code)) = v_code;
  if not found or not r.is_active then
    return query select null::uuid, 'not_found'::text; return;
  end if;
  if r.valid_from is not null and r.valid_from > now() then
    return query select r.id, 'not_started'::text; return;
  end if;
  if r.valid_until is not null and r.valid_until < now() then
    return query select r.id, 'expired'::text; return;
  end if;
  if r.max_uses is not null and r.uses_count >= r.max_uses then
    return query select r.id, 'used_up'::text; return;
  end if;
  return query select r.id, 'ok'::text;
end;
$$;
revoke all on function public.promo_code_status(text) from public, anon, authenticated;
grant execute on function public.promo_code_status(text) to service_role;

-- Customer side: what does this code give? (a signed-in customer or admin)
create or replace function public.redeem_promo_code(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s record;
  r public.promo_codes%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('valid', false, 'reason', 'sign_in');
  end if;
  select * into s from public.promo_code_status(p_code);
  if s.reason is distinct from 'ok' then
    return jsonb_build_object('valid', false, 'reason', coalesce(s.reason, 'not_found'));
  end if;
  select * into r from public.promo_codes where promo_codes.id = s.id;
  return jsonb_build_object(
    'valid', true,
    'rule', jsonb_build_object(
      'id', 'code:' || r.id::text,
      'code', r.code,
      'name', r.name,
      'type', r.discount_type,
      'value', r.discount_value,
      'vehicleTypes', to_jsonb(r.vehicle_types),
      'serviceMatches', to_jsonb(r.service_names),
      'validFrom', r.valid_from,
      'validUntil', r.valid_until,
      'neverExpires', r.valid_until is null,
      'active', true
    )
  );
end;
$$;
revoke all on function public.redeem_promo_code(text) from public, anon;
grant execute on function public.redeem_promo_code(text) to authenticated, service_role;

-- Booking side: the code on a new booking must be valid, and its use is counted.
create or replace function public.bookings_apply_promo_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
begin
  if nullif(btrim(coalesce(new.promo_code, '')), '') is null then
    new.promo_code := null;
    return new;
  end if;

  -- Lock the code so two bookings cannot both take the last use.
  perform 1 from public.promo_codes where lower(btrim(code)) = lower(btrim(new.promo_code)) for update;
  select * into s from public.promo_code_status(new.promo_code);
  if s.reason is distinct from 'ok' then
    raise exception 'This promo code is not valid or has expired.'
      using errcode = 'check_violation';
  end if;

  update public.promo_codes set uses_count = uses_count + 1 where promo_codes.id = s.id
  returning code into new.promo_code;
  return new;
end;
$$;

drop trigger if exists trg_bookings_apply_promo_code on public.bookings;
create trigger trg_bookings_apply_promo_code
  before insert on public.bookings
  for each row execute function public.bookings_apply_promo_code();

-- The atomic booking function stores the code it was given.
do $patch$
declare
  v_oid oid;
  v_source text;
  v_patched text;
  v_columns text := 'applied_promo_id, promo_name_snapshot, discount_amount_snapshot' || chr(10) || '  )';
  v_values  text := 'coalesce((v_booking ->> ' || quote_literal('discount_amount_snapshot') || ')::numeric, 0)' || chr(10) || '  returning id into v_booking_id;';
begin
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic' and p.pronargs = 1
   limit 1;
  if v_oid is null then
    raise exception 'create_booking_atomic(jsonb) was not found; refusing to skip storing the promo code.';
  end if;

  v_source := pg_get_functiondef(v_oid);
  if position('promo_code' in v_source) > 0 then
    raise notice 'create_booking_atomic already stores the promo code.';
    return;
  end if;
  if position(v_columns in v_source) = 0 or position(v_values in v_source) = 0 then
    raise exception 'Could not safely patch create_booking_atomic() to store the promo code.';
  end if;

  v_patched := replace(v_source, v_columns,
    'applied_promo_id, promo_name_snapshot, discount_amount_snapshot, promo_code' || chr(10) || '  )');
  v_patched := replace(v_patched, v_values,
    'coalesce((v_booking ->> ' || quote_literal('discount_amount_snapshot') || ')::numeric, 0),' || chr(10) ||
    '    nullif(btrim(v_booking ->> ' || quote_literal('promo_code') || '), ' || quote_literal('') || ')' || chr(10) ||
    '  returning id into v_booking_id;');
  execute v_patched;
end;
$patch$;

-- ============================================================================
-- 2. Terms and conditions: one text, edited in the Business Hub, shown on the
--    last page of booking creation. The current wording is kept as the starting
--    text so nothing changes until an admin edits it.
-- ============================================================================
alter table public.business_config
  add column if not exists terms_and_conditions text,
  add column if not exists terms_updated_at timestamptz;

update public.business_config
   set terms_and_conditions = '1. Customer information provided during booking is collected solely for scheduling, service communication, and payment verification.' || chr(10) ||
       '2. All bookings are subject to vehicle condition, available staff capacity, and service timing confirmation by the studio.' || chr(10) ||
       '3. Deposits and payments remain subject to the studio''s refund and cancellation policy as disclosed in the booking confirmation.' || chr(10) ||
       '4. Customers agree to provide truthful vehicle details and to keep the contact information current for appointment updates.' || chr(10) ||
       '5. By submitting this booking, the customer authorizes the studio to process personal data required for service delivery, account management, and operational communications.',
       terms_updated_at = now()
 where nullif(btrim(coalesce(terms_and_conditions, '')), '') is null;
