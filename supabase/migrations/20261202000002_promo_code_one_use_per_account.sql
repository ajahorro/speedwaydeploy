-- A promo code can be used once per account. Its usage limit is therefore the number of customers who can use it.
-- The check is made when the customer (or an admin booking for them) enters the code, and again when the booking is
-- created, so a stale or tampered browser cannot use a code twice.

create or replace function public.promo_code_used_by(p_code text, p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_customer_id is not null and exists (
    select 1 from public.bookings b
     where b.customer_id = p_customer_id
       and lower(btrim(coalesce(b.promo_code, ''))) = lower(btrim(coalesce(p_code, '')))
  );
$$;
revoke all on function public.promo_code_used_by(text, uuid) from public, anon, authenticated;
grant execute on function public.promo_code_used_by(text, uuid) to service_role;

drop function if exists public.redeem_promo_code(text);
create or replace function public.redeem_promo_code(p_code text, p_customer_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s record;
  r public.promo_codes%rowtype;
  v_customer uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('valid', false, 'reason', 'sign_in');
  end if;
  select * into s from public.promo_code_status(p_code);
  if s.reason is distinct from 'ok' then
    return jsonb_build_object('valid', false, 'reason', coalesce(s.reason, 'not_found'));
  end if;
  -- an admin booking for a customer checks that customer's account; everyone else checks their own
  v_customer := case when p_customer_id is not null and public.is_admin() then p_customer_id else auth.uid() end;
  if public.promo_code_used_by(p_code, v_customer) then
    return jsonb_build_object('valid', false, 'reason', 'already_used');
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
revoke all on function public.redeem_promo_code(text, uuid) from public, anon;
grant execute on function public.redeem_promo_code(text, uuid) to authenticated, service_role;

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
  if public.promo_code_used_by(new.promo_code, new.customer_id) then
    raise exception 'This account has already used this promo code.'
      using errcode = 'check_violation';
  end if;

  update public.promo_codes set uses_count = uses_count + 1 where promo_codes.id = s.id
  returning code into new.promo_code;
  return new;
end;
$$;
