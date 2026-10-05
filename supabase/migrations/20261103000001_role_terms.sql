-- ============================================================================
-- 1.11 / 4.5 Role-specific terms and conditions.
--
-- business_config keeps one text and one version number per role. profiles
-- records which version an account accepted. Publishing a changed text bumps
-- that role's version, so every account of the role is asked again. Acceptance
-- and publishing both go through functions (and are written to the audit log);
-- nobody edits these columns directly.
-- ============================================================================
alter table public.business_config
  add column if not exists terms_customer text,
  add column if not exists terms_staff text,
  add column if not exists terms_admin text,
  add column if not exists terms_customer_version integer not null default 1,
  add column if not exists terms_staff_version integer not null default 1,
  add column if not exists terms_admin_version integer not null default 1;

alter table public.profiles
  add column if not exists accepted_terms_version integer,
  add column if not exists accepted_terms_at timestamptz;

-- the existing single text becomes the customer text
update public.business_config
   set terms_customer = coalesce(nullif(btrim(terms_customer), ''), terms_and_conditions)
 where nullif(btrim(coalesce(terms_customer, '')), '') is null;

update public.business_config
   set terms_staff = '1. Technicians perform only the services assigned to them and follow the studio''s service standards for every vehicle.' || chr(10) ||
       '2. Before-service and after-service photos are required evidence. Submitted photos are locked and may not be altered or removed.' || chr(10) ||
       '3. Customer contact details and vehicle information are confidential and are used only to carry out the assigned job.' || chr(10) ||
       '4. Clock in and out accurately. Report vehicle damage, delays or safety concerns to an administrator immediately.' || chr(10) ||
       '5. Account credentials are personal. Do not share them, and sign out of shared devices.'
 where nullif(btrim(coalesce(terms_staff, '')), '') is null;

update public.business_config
   set terms_admin = '1. Administrators act on behalf of the studio and are accountable for every action recorded under their account.' || chr(10) ||
       '2. Payment verification, refunds, cancellations and receivable entries must follow the studio''s payment and refund policies.' || chr(10) ||
       '3. Customer, staff and payment data are confidential and may be accessed only for legitimate business purposes.' || chr(10) ||
       '4. Changes to the Business Hub (schedule, services, promotions, payment policy, terms) take effect immediately for all users.' || chr(10) ||
       '5. Account credentials are personal. Do not share them, and never approve access for someone you cannot identify.'
 where nullif(btrim(coalesce(terms_admin, '')), '') is null;

-- ── Which role's terms apply to the caller ──────────────────────────────────
create or replace function public.terms_role_key(p_role text)
returns text
language sql
immutable
as $$
  select case upper(coalesce(p_role, ''))
    when 'STAFF' then 'staff'
    when 'ADMIN' then 'admin'
    when 'SUPER_ADMIN' then 'admin'
    else 'customer'
  end;
$$;

-- ── Accept the current version of my own role's terms ───────────────────────
create or replace function public.accept_terms()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_profile record;
  v_key text;
  v_version integer;
begin
  select id, role, full_name, email into v_profile from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Sign in to accept the terms.' using errcode = '42501';
  end if;
  v_key := public.terms_role_key(v_profile.role::text);
  execute format('select coalesce(terms_%s_version, 1) from public.business_config order by id limit 1', v_key) into v_version;
  v_version := coalesce(v_version, 1);

  update public.profiles
     set accepted_terms_version = v_version, accepted_terms_at = now()
   where id = v_profile.id;

  insert into public.audit_logs (action_type, details, actor_name, actor_role, actor_id, metadata)
  values ('TERMS_ACCEPTED', 'Accepted the ' || v_key || ' terms and conditions (version ' || v_version || ').',
          coalesce(v_profile.full_name, v_profile.email), v_profile.role::text, v_profile.id,
          jsonb_build_object('terms_role', v_key, 'version', v_version));

  return jsonb_build_object('version', v_version);
end;
$fn$;

-- ── Admin publishes a new text for one role ────────────────────────────────
create or replace function public.publish_terms(p_role text, p_text text)
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
    raise exception 'Only an administrator can edit the terms.' using errcode = '42501';
  end if;
  if v_key not in ('customer', 'staff', 'admin') then
    raise exception 'Unknown terms audience.';
  end if;
  if nullif(btrim(coalesce(p_text, '')), '') is null then
    raise exception 'The terms cannot be empty.';
  end if;

  execute format('select terms_%s from public.business_config order by id limit 1', v_key) into v_old;
  if btrim(coalesce(v_old, '')) = btrim(p_text) then
    raise exception 'Nothing changed. Edit the text before publishing.';
  end if;

  execute format(
    'update public.business_config set terms_%1$s = $1, terms_%1$s_version = coalesce(terms_%1$s_version, 1) + 1, terms_updated_at = now() where id = (select id from public.business_config order by id limit 1)',
    v_key) using btrim(p_text);
  -- keep the legacy single column aligned with the customer text
  if v_key = 'customer' then
    update public.business_config set terms_and_conditions = btrim(p_text)
     where id = (select id from public.business_config order by id limit 1);
  end if;
  execute format('select terms_%s_version from public.business_config order by id limit 1', v_key) into v_version;

  select full_name, email, role into v_actor from public.profiles where id = auth.uid();
  insert into public.audit_logs (action_type, details, actor_name, actor_role, actor_id, metadata)
  values ('TERMS_PUBLISHED', 'Published version ' || v_version || ' of the ' || v_key || ' terms and conditions.',
          coalesce(v_actor.full_name, v_actor.email), v_actor.role::text, auth.uid(),
          jsonb_build_object('terms_role', v_key, 'version', v_version));

  return jsonb_build_object('role', v_key, 'version', v_version);
end;
$fn$;

revoke all on function public.accept_terms() from public, anon;
revoke all on function public.publish_terms(text, text) from public, anon;
grant execute on function public.accept_terms() to authenticated;
grant execute on function public.publish_terms(text, text) to authenticated;
