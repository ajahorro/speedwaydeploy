-- ============================================================================
-- 20261019000001_fix_invite_service_role_guard.sql
-- ============================================================================
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Reported symptom: "I cannot invite staff or admin even though I am an admin."
-- The backend answered 403 with "Only administrators may invite accounts."
--
-- ROOT CAUSE (defect, not configuration)
-- --------------------------------------
-- The invite route (backend/server.js) does two things, in order:
--
--   1. requireAdmin(req) — validates the CALLER's JWT and confirms their profile
--      role is ADMIN. This is correct and it PASSES for a real admin.
--
--   2. supabaseAdmin.rpc('create_invited_account', ...) — the atomic duplicate
--      guard. But supabaseAdmin is the SERVICE-ROLE client: it carries the
--      service key, NOT the caller's JWT, so `auth.uid()` is NULL inside the
--      function.
--
-- The RPC's own guard was `if not public.is_admin()`, and is_admin() is:
--
--     select exists (select 1 from profiles
--                     where id = auth.uid() and role = 'ADMIN' ...)
--
-- With auth.uid() NULL that is ALWAYS false, so the RPC raised
-- 'Only administrators may invite accounts' on EVERY backend call — including
-- from a legitimate, verified administrator. The backend's own (correct) gate
-- was never the problem; the RPC's redundant guard evaluated the wrong identity.
--
-- The same defect existed in elevate_profile_role() (migration 20261018000005):
-- it too did `if not public.is_admin()` and so could never elevate an existing
-- customer to STAFF/ADMIN through the backend. It also lost the audit actor
-- because the backend passed `actor.id` (undefined) where `actor.profile.id`
-- was meant — fixed in server.js alongside this migration.
--
-- THE FIX
-- -------
-- Introduce ONE helper, public.is_privileged_caller(), that is true when EITHER
--   (a) a real ADMIN is calling through their own JWT (auth.uid() set), OR
--   (b) the caller is the SERVICE ROLE (auth.uid() is null AND the request is
--       executing as the service_role Postgres role), which is exactly the
--       trusted backend that has already run requireAdmin on the caller's JWT.
--
-- This preserves defence in depth: an ordinary signed-in user (customer/staff)
-- calling these RPCs directly from the browser is still refused, because for
-- them auth.uid() is set and their role is not ADMIN. Only the server, which
-- holds the service key and never exposes it, gains the bypass.
-- ============================================================================

-- ── 1. Shared privileged-caller predicate ───────────────────────────────────
create or replace function public.is_privileged_caller()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    -- (a) A real, active ADMIN authenticating with their own JWT.
    public.is_admin()
    or
    -- (b) The trusted server-side client. Two independent signals must agree:
    --     no end-user JWT identity, and the Postgres role is the service role.
    --     `current_setting('role')` is 'service_role' for a service-key request
    --     on Supabase; we also accept the request.jwt.claim.role form for hosts
    --     that populate it, so a future platform change cannot silently
    --     re-break invitations.
    (
      auth.uid() is null
      and (
        coalesce(current_setting('role', true), '') = 'service_role'
        or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
        or coalesce(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' = 'service_role'
      )
    );
$$;

comment on function public.is_privileged_caller() is
  'TRUE for an active ADMIN calling with their own JWT, OR for the trusted service-role backend (which has already verified the caller). Used by invite/elevation RPCs so the backend can act on an admin''s behalf without auth.uid() being set.';

revoke all on function public.is_privileged_caller() from public;
grant execute on function public.is_privileged_caller() to authenticated, service_role;

-- ── 2. Re-issue create_invited_account with the correct guard ───────────────
create or replace function public.create_invited_account(
  p_email text,
  p_first_name text,
  p_last_name text,
  p_role text,
  p_must_change_password boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_role text := upper(btrim(coalesce(p_role, '')));
  v_auth_exists boolean;
  v_profile_exists boolean;
  v_profile_id uuid;
  v_current_role text;
  v_can_elevate boolean := false;
begin
  -- Was: `if not public.is_admin()` — always false for the service-role backend.
  if not public.is_privileged_caller() then
    raise exception 'Only administrators may invite accounts';
  end if;

  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'A valid email address is required';
  end if;

  if v_role not in ('STAFF', 'ADMIN') then
    raise exception 'Role must be STAFF or ADMIN';
  end if;

  -- Atomic existence lookup. Serialize concurrent invites for the same address
  -- so two admins cannot race past the check and create duplicate auth users.
  perform pg_advisory_xact_lock(hashtext('speedway:invite:' || v_email));

  select exists (select 1 from auth.users u where lower(u.email) = v_email)
    into v_auth_exists;
  select exists (select 1 from public.profiles p where lower(p.email) = v_email)
    into v_profile_exists;

  if v_auth_exists or v_profile_exists then
    -- Distinguish "already staff/admin" from "existing customer who could be
    -- elevated", so the backend can offer role elevation instead of a dead end.
    select id, upper(coalesce(role, ''))
      into v_profile_id, v_current_role
      from public.profiles
     where lower(btrim(coalesce(email, ''))) = v_email
     limit 1;

    -- Elevatable when a profile exists and is NOT already at the requested role.
    v_can_elevate := v_profile_id is not null
      and coalesce(v_current_role, '') <> v_role;

    raise exception 'EMAIL_ALREADY_EXISTS' using errcode = '23505';
  end if;

  return jsonb_build_object(
    'email', v_email,
    'role', v_role,
    'first_name', btrim(coalesce(p_first_name, '')),
    'last_name', btrim(coalesce(p_last_name, '')),
    'must_change_password', coalesce(p_must_change_password, true),
    'exists', false,
    'can_elevate', false
  );
end;
$$;

revoke all on function public.create_invited_account(text, text, text, text, boolean) from public;
grant execute on function public.create_invited_account(text, text, text, text, boolean) to authenticated, service_role;

-- ── 3. Re-issue elevate_profile_role with the correct guard ─────────────────
create or replace function public.elevate_profile_role(
  p_email text,
  p_role text,
  p_first_name text default null,
  p_last_name text default null,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email      text := lower(btrim(coalesce(p_email, '')));
  v_role       text := upper(btrim(coalesce(p_role, '')));
  v_profile    public.profiles%rowtype;
  v_old_role   text;
  v_actor      uuid := coalesce(p_actor_id, auth.uid());
begin
  -- Was: `if not public.is_admin()` — always false for the service-role backend.
  if not public.is_privileged_caller() then
    raise exception 'Only administrators may change account roles';
  end if;

  if v_role not in ('STAFF', 'ADMIN') then
    raise exception 'Role must be STAFF or ADMIN';
  end if;

  perform pg_advisory_xact_lock(hashtext('speedway:invite:' || v_email));

  select * into v_profile
    from public.profiles
   where lower(btrim(coalesce(email, ''))) = v_email
   for update;

  if not found then
    return jsonb_build_object('elevated', false, 'reason', 'NO_PROFILE', 'email', v_email);
  end if;

  v_old_role := upper(coalesce(v_profile.role, ''));

  -- Never silently demote an existing ADMIN through this path.
  if v_old_role = 'ADMIN' and v_role <> 'ADMIN' then
    raise exception 'Refusing to demote an existing ADMIN via the invite flow';
  end if;

  if v_old_role = v_role and coalesce(v_profile.is_active, true) then
    return jsonb_build_object(
      'elevated', false, 'reason', 'ALREADY_AT_ROLE',
      'profile_id', v_profile.id, 'role', v_role, 'email', v_email
    );
  end if;

  update public.profiles
     set role = v_role,
         first_name = coalesce(nullif(btrim(coalesce(p_first_name, '')), ''), first_name),
         last_name  = coalesce(nullif(btrim(coalesce(p_last_name, '')), ''), last_name),
         full_name  = coalesce(nullif(btrim(concat_ws(' ', nullif(p_first_name,''), nullif(p_last_name,''))), ''),
                               full_name),
         is_active = true,
         deactivated_at = null,
         updated_at = now()
   where id = v_profile.id;

  insert into public.audit_logs (
    action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    'ROLE_ELEVATED',
    format('Account role elevated from %s to %s via invite.', coalesce(nullif(v_old_role,''),'NONE'), v_role),
    coalesce((select full_name from public.profiles where id = v_actor), 'Administrator'),
    'ADMIN', v_actor,
    jsonb_build_object('profile_id', v_profile.id, 'email', v_email, 'old_role', v_old_role, 'new_role', v_role)
  );

  return jsonb_build_object(
    'elevated', true,
    'profile_id', v_profile.id,
    'old_role', v_old_role,
    'role', v_role,
    'email', v_email
  );
end;
$$;

revoke all on function public.elevate_profile_role(text, text, text, text, uuid) from public;
grant execute on function public.elevate_profile_role(text, text, text, text, uuid) to authenticated, service_role;