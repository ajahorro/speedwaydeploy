-- ============================================================================
-- Batch 1 Additions — Scenario 12: Invite Link Identity Clash (Role Mapping)
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- An admin sends a STAFF invite to john@domain.com. John previously booked a car
-- wash as a guest/customer two years ago, so his email already exists as a
-- CUSTOMER profile (and possibly an auth.users row). The old flow:
--
--   create_invited_account('john@domain.com', ..., 'STAFF')
--     -> sees the email exists under ANY role
--     -> raise 'EMAIL_ALREADY_EXISTS' (23505)
--     -> backend maps it to a 409 "An account already exists"
--
-- So a long-standing customer could NEVER be promoted to staff through the
-- invite flow — the admin was simply blocked. Worse, the fallback path had the
-- same refusal, so there was no way around it.
--
-- THE FIX
-- -------
-- A dedicated, ADMIN-ONLY role-elevation RPC, `elevate_profile_role()`, that:
--   * lowers + matches the email case-insensitively,
--   * refuses to touch an already-ADMIN account (no silent demotion),
--   * preserves the existing profile row and its history (it is an UPDATE, not a
--     delete/insert, so bookings.customer_id, audit_logs.actor_id and every FK
--     stay intact),
--   * elevates CUSTOMER/STAFF -> the requested STAFF/ADMIN role,
--   * reactivates a soft-deleted (is_active = false) account,
--   * writes a 'ROLE_ELEVATED' audit row recording the old and new role.
--
-- `create_invited_account()` is re-created to RETURN the existing identity
-- (instead of raising) when the email is a CUSTOMER profile, so the backend can
-- route that case to the elevation path rather than a dead-end 409.
-- ============================================================================

-- ── 1. Role elevation RPC ───────────────────────────────────────────────────
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
  if not public.is_admin() then
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
    -- No profile to elevate; caller must use the plain create path.
    return jsonb_build_object('elevated', false, 'reason', 'NO_PROFILE', 'email', v_email);
  end if;

  v_old_role := upper(coalesce(v_profile.role, ''));

  -- Never silently demote an existing ADMIN through this path.
  if v_old_role = 'ADMIN' and v_role <> 'ADMIN' then
    raise exception 'Refusing to demote an existing ADMIN via the invite flow';
  end if;

  -- Already at (or above) the requested role: idempotent success, no churn.
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

  -- Clean audit trail of the elevation.
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
    'role', v_role,
    'old_role', v_old_role,
    'email', v_email,
    'must_change_password', coalesce(v_profile.must_change_password, true)
  );
end;
$$;

comment on function public.elevate_profile_role(text, text, text, text, uuid) is
  'Scenario 12: promotes an existing CUSTOMER/STAFF profile to STAFF/ADMIN via the invite flow, preserving all history (FKs intact), reactivating a soft-deleted account, and refusing to demote an ADMIN. Writes a ROLE_ELEVATED audit row.';

revoke all on function public.elevate_profile_role(text, text, text, text, uuid) from public;
grant execute on function public.elevate_profile_role(text, text, text, text, uuid) to authenticated;


-- ── 2. Upgrade-aware invite claim ───────────────────────────────────────────
-- Re-create create_invited_account() so it no longer DEAD-ENDS on an existing
-- CUSTOMER profile. It now reports the situation so the caller can decide:
--   * existing CUSTOMER profile (no conflicting staff)  -> { exists: true, can_elevate: true }
--   * existing ADMIN profile                             -> raise (never demote)
--   * existing auth user without a profile               -> raise (needs manual repair)
--   * genuinely new email                                -> { exists: false }
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
  v_profile public.profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only administrators may invite accounts';
  end if;

  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'A valid email address is required';
  end if;

  if v_role not in ('STAFF', 'ADMIN') then
    raise exception 'Role must be STAFF or ADMIN';
  end if;

  perform pg_advisory_xact_lock(hashtext('speedway:invite:' || v_email));

  select exists (select 1 from auth.users u where lower(u.email) = v_email)
    into v_auth_exists;

  select * into v_profile
    from public.profiles p
   where lower(btrim(coalesce(p.email, ''))) = v_email
   limit 1;

  if found then
    -- Scenario 12: an existing CUSTOMER (or STAFF) is eligible for elevation.
    if upper(coalesce(v_profile.role, '')) = 'ADMIN' then
      raise exception 'EMAIL_ALREADY_EXISTS' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'exists', true,
      'can_elevate', true,
      'profile_id', v_profile.id,
      'current_role', upper(coalesce(v_profile.role, '')),
      'email', v_email,
      'requested_role', v_role
    );
  end if;

  if v_auth_exists then
    -- An auth user with no profile: a repair case, never a silent duplicate.
    raise exception 'EMAIL_ALREADY_EXISTS' using errcode = '23505';
  end if;

  return jsonb_build_object(
    'exists', false,
    'can_elevate', false,
    'email', v_email,
    'role', v_role,
    'first_name', btrim(coalesce(p_first_name, '')),
    'last_name', btrim(coalesce(p_last_name, '')),
    'must_change_password', coalesce(p_must_change_password, true)
  );
end;
$$;

comment on function public.create_invited_account(text, text, text, text, boolean) is
  'Scenario 12: invite claim that reports an existing CUSTOMER profile as eligible for elevation (instead of hard-failing), raises only for an ADMIN collision or a profile-less auth user, and returns exists=false for a genuinely new address.';

revoke all on function public.create_invited_account(text, text, text, text, boolean) from public;
grant execute on function public.create_invited_account(text, text, text, text, boolean) to authenticated;