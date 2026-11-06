-- Privacy & security policy, next to the terms and conditions.
--
-- Same model as the role terms (20261103000001_role_terms.sql): one text and one version per role in
-- business_config, the accepted version on each profile, publishing and accepting only through functions, both
-- written to the audit log. Publishing a changed text bumps that role's version, so everyone in the role is asked
-- to read and agree again the next time they sign in (new accounts are asked on their first open).
-- accept_current_policies() records both documents at once, for the single pop-up that shows whatever changed.

alter table public.business_config
  add column if not exists security_policy_customer text,
  add column if not exists security_policy_staff text,
  add column if not exists security_policy_admin text,
  add column if not exists security_policy_customer_version integer not null default 1,
  add column if not exists security_policy_staff_version integer not null default 1,
  add column if not exists security_policy_admin_version integer not null default 1;

alter table public.profiles
  add column if not exists accepted_security_version integer,
  add column if not exists accepted_security_at timestamptz;

-- Starting texts in plain words. Administrators can rewrite them in Business Hub › Terms & Policies.
update public.business_config set security_policy_customer =
  '1. We collect only what we need to serve you: your name, contact details, vehicle details, booking history, payment receipts and the before and after photos of your vehicle.' || chr(10) ||
  '2. We use this information to schedule and carry out your service, confirm your payments, send booking updates and keep records required for our business.' || chr(10) ||
  '3. Only our staff and administrators can see your information, and only for your bookings. We do not sell or share it with others except when the law requires it.' || chr(10) ||
  '4. Payment receipts are checked automatically and by an administrator. We never ask for your card number, PIN, OTP or online banking password.' || chr(10) ||
  '5. Your password is stored in a protected form that no one at the shop can read. Keep it private, and sign out on shared devices.' || chr(10) ||
  '6. You can view and update your details on your profile at any time, and you can ask us to delete your account data from Settings.' || chr(10) ||
  '7. We handle personal information following the Data Privacy Act of 2012 (Republic Act No. 10173). Contact us through the app for any privacy concern.'
 where nullif(btrim(coalesce(security_policy_customer, '')), '') is null;

update public.business_config set security_policy_staff =
  '1. Your account is for you only. Never share your password or let someone else use your signed-in device.' || chr(10) ||
  '2. Customer names, phone numbers, vehicles and photos are confidential. Use them only for the job assigned to you, and never copy or post them elsewhere.' || chr(10) ||
  '3. Take service photos only of the vehicle you are working on, and only through the app.' || chr(10) ||
  '4. Sign out of shared devices when you finish, and tell an administrator right away if you think someone else used your account.' || chr(10) ||
  '5. Every action in the app is recorded with your name and the time.'
 where nullif(btrim(coalesce(security_policy_staff, '')), '') is null;

update public.business_config set security_policy_admin =
  '1. Your account can see and change customer, staff and payment records. Never share your password or leave a signed-in device unattended.' || chr(10) ||
  '2. Open customer and payment information only for real shop work, and never send it outside the app.' || chr(10) ||
  '3. Confirm who you are dealing with before changing an account, approving a payment or sending a refund.' || chr(10) ||
  '4. Invite staff and administrators only for people who work for the shop, and deactivate accounts as soon as someone leaves.' || chr(10) ||
  '5. Report anything suspicious (unknown sign-ins, odd payments, lost devices) to the shop owner straight away.' || chr(10) ||
  '6. Every action in the app is recorded with your name and the time.'
 where nullif(btrim(coalesce(security_policy_admin, '')), '') is null;

-- ── Only these functions (or the server) may set the accepted version ──────────────────────────────────────────
create or replace function public.guard_security_acceptance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.accepted_security_version is distinct from old.accepted_security_version
      or new.accepted_security_at is distinct from old.accepted_security_at)
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and not (coalesce(current_setting('app.allow_policy_accept', true), '') = 'true' and auth.uid() is not null and old.id = auth.uid()) then
    raise exception 'The security policy can only be accepted from its pop-up.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_security_acceptance on public.profiles;
create trigger trg_guard_security_acceptance
  before update of accepted_security_version, accepted_security_at on public.profiles
  for each row execute function public.guard_security_acceptance();

-- ── Accept whatever is current for my role: terms and security policy together ─────────────────────────────────
create or replace function public.accept_current_policies()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_profile record;
  v_key text;
  v_terms integer;
  v_security integer;
begin
  select id, role, full_name, email, accepted_terms_version, accepted_security_version
    into v_profile from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Sign in to accept the terms.' using errcode = '42501';
  end if;
  v_key := public.terms_role_key(v_profile.role::text);
  execute format('select coalesce(terms_%1$s_version, 1), coalesce(security_policy_%1$s_version, 1) from public.business_config order by id limit 1', v_key)
    into v_terms, v_security;

  perform set_config('app.allow_terms_accept', 'true', true);
  perform set_config('app.allow_policy_accept', 'true', true);
  update public.profiles
     set accepted_terms_version = v_terms,
         accepted_terms_at = case when coalesce(accepted_terms_version, 0) < v_terms then now() else accepted_terms_at end,
         accepted_security_version = v_security,
         accepted_security_at = case when coalesce(accepted_security_version, 0) < v_security then now() else accepted_security_at end
   where id = v_profile.id;

  insert into public.audit_logs (action_type, details, actor_name, actor_role, actor_id, metadata)
  values ('TERMS_ACCEPTED',
          'Agreed to the ' || v_key || ' terms and conditions (version ' || v_terms || ') and privacy & security policy (version ' || v_security || ').',
          coalesce(v_profile.full_name, v_profile.email), v_profile.role::text, v_profile.id,
          jsonb_build_object('terms_role', v_key, 'terms_version', v_terms, 'security_version', v_security));

  return jsonb_build_object('terms_version', v_terms, 'security_version', v_security);
end;
$fn$;

-- ── Admin publishes a new privacy & security text for one role ─────────────────────────────────────────────────
create or replace function public.publish_security_policy(p_role text, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_key text := lower(btrim(coalesce(p_role, '')));
  v_old text;
  v_version integer;
  v_actor record;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can edit the security policy.' using errcode = '42501';
  end if;
  if v_key not in ('customer', 'staff', 'admin') then
    raise exception 'Unknown policy audience.';
  end if;
  if nullif(btrim(coalesce(p_text, '')), '') is null then
    raise exception 'The policy cannot be empty.';
  end if;
  if char_length(p_text) > 20000 then
    raise exception 'The policy is too long.';
  end if;

  execute format('select security_policy_%s from public.business_config order by id limit 1', v_key) into v_old;
  if btrim(coalesce(v_old, '')) = btrim(p_text) then
    raise exception 'Nothing changed. Edit the text before publishing.';
  end if;

  execute format(
    'update public.business_config set security_policy_%1$s = $1, security_policy_%1$s_version = coalesce(security_policy_%1$s_version, 1) + 1 where id = (select id from public.business_config order by id limit 1)',
    v_key) using btrim(p_text);
  execute format('select security_policy_%s_version from public.business_config order by id limit 1', v_key) into v_version;

  select full_name, email, role into v_actor from public.profiles where id = auth.uid();
  insert into public.audit_logs (action_type, details, actor_name, actor_role, actor_id, metadata)
  values ('TERMS_PUBLISHED', 'Published version ' || v_version || ' of the ' || v_key || ' privacy & security policy.',
          coalesce(v_actor.full_name, v_actor.email), v_actor.role::text, auth.uid(),
          jsonb_build_object('policy', 'security', 'terms_role', v_key, 'version', v_version));

  return jsonb_build_object('role', v_key, 'version', v_version);
end;
$fn$;

revoke all on function public.accept_current_policies() from public, anon;
revoke all on function public.publish_security_policy(text, text) from public, anon;
grant execute on function public.accept_current_policies() to authenticated;
grant execute on function public.publish_security_policy(text, text) to authenticated;
