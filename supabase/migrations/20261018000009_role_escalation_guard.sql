-- ============================================================================
-- Batch 1 Additions — Scenario 16: Malicious Payload Role Escalation
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `AuthContext.updateProfile(updates)` runs, authenticated as the USER's own
-- JWT:
--
--     supabase.from('profiles').update(updates).eq('id', user.id)
--
-- The `updates` object is passed through verbatim. A customer who intercepts
-- their own profile-update request (proxy / devtools / a malicious client) can
-- inject `{ "role": "ADMIN" }`. The ONLY thing standing between that payload and
-- full privilege escalation is RLS + column privileges on public.profiles.
--
-- A single permissive "users can update their own profile" policy — the common
-- default — would allow the whole row to be written, including `role`. That is a
-- catastrophic, silent escalation: no error, no 500, just an instant admin.
--
-- THE FIX (defence in depth — ALL layers)
-- ---------------------------------------
--   1. A BEFORE UPDATE trigger, `guard_profile_privileged_columns()`, that:
--        * raises for ANY change to `role`, `is_active`, `deactivated_at`,
--          `failed_login_attempts`, `locked_until`, `must_change_password`,
--          `is_clocked_in`, `clock_in_timestamp` when the caller is NOT an admin;
--        * allows an admin (or the service_role, which bypasses RLS but still
--          fires triggers — we special-case it) to make those changes.
--      This is the authoritative guard: it fires on DIRECT writes too, so even a
--      future permissive RLS policy cannot be abused to change a role.
--
--   2. Hardened RLS policies on public.profiles:
--        * SELECT: self, or any admin.
--        * UPDATE: self OR admin — BUT the trigger above constrains WHAT may
--          change, so "self" can only touch safe columns.
--
--   3. A safe self-update RPC `update_my_profile()` that accepts ONLY the
--      permitted fields, so the legitimate client path is explicit and cannot
--      accidentally widen.
-- ============================================================================

-- ── 1. The authoritative column guard (fires on direct writes too) ──────────
create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Columns a NON-admin may never change on any profile row.
  v_protected text[] := array[
    'role', 'is_active', 'deactivated_at', 'failed_login_attempts',
    'locked_until', 'must_change_password', 'is_clocked_in',
    'clock_in_timestamp', 'email_change_temp', 'role_version'
  ];
  v_col text;
  v_old jsonb;
  v_new jsonb;
  v_is_admin boolean;
  v_is_service boolean;
begin
  -- service_role / backend (SECURITY DEFINER chains) may manage privileged
  -- columns — the API layer has already performed its own authorization.
  --
  -- We key off the JWT CLAIM role only (this is exactly how Supabase's PostgREST
  -- distinguishes callers: anon / authenticated / service_role). We deliberately
  -- do NOT exempt on `current_user`: under a connection pooler the session role
  -- can be `postgres`/`supabase_admin` for EVERY caller, and exempting it would
  -- silently disable this guard in production.
  v_is_service := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';

  if v_is_service then
    return new;
  end if;

  v_is_admin := public.is_admin();

  -- Compare the JSONB images so we detect ANY change to a protected column.
  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  foreach v_col in array v_protected loop
    if not v_is_admin and (v_new -> v_col) is distinct from (v_old -> v_col) then
      raise exception 'Column % is protected and may only be changed by an administrator.', v_col
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.guard_profile_privileged_columns() is
  'Scenario 16: refuses any change to role/is_active/privileged columns unless the caller is an ADMIN or the service_role. Blocks self-escalation even via a direct table write, so a permissive RLS policy cannot be abused.';

drop trigger if exists trg_guard_profile_privileged_columns on public.profiles;
create trigger trg_guard_profile_privileged_columns
  before update on public.profiles
  for each row
  execute function public.guard_profile_privileged_columns();


-- ── 2. RLS policies (self-or-admin, constrained by the trigger) ─────────────
alter table public.profiles enable row level security;

do $$
begin
  -- SELECT: a user may read their own row; an admin may read every row.
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_select_self_or_admin'
  ) then
    create policy profiles_select_self_or_admin on public.profiles
      for select
      using (id = auth.uid() or public.is_admin());
  end if;

  -- UPDATE: a user may update their own row; an admin may update any.
  -- The trigger above is what actually stops `role` being changed by "self".
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_update_self_or_admin'
  ) then
    create policy profiles_update_self_or_admin on public.profiles
      for update
      using (id = auth.uid() or public.is_admin())
      with check (id = auth.uid() or public.is_admin());
  end if;
end $$;


-- ── 3. Explicit safe self-update RPC ────────────────────────────────────────
-- The legitimate client path should never send an arbitrary object. This RPC
-- accepts ONLY the fields a user is allowed to change, so the UI can call it and
-- the widened payload becomes impossible by construction.
create or replace function public.update_my_profile(
  p_first_name text default null,
  p_last_name text default null,
  p_phone_number text default null,
  p_push_notifications_enabled boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.profiles
     set first_name = coalesce(p_first_name, first_name),
         last_name = coalesce(p_last_name, last_name),
         full_name = case
           when p_first_name is not null or p_last_name is not null
           then btrim(concat_ws(' ',
                  coalesce(p_first_name, first_name),
                  coalesce(p_last_name, last_name)))
           else full_name
         end,
         phone_number = coalesce(p_phone_number, phone_number),
         push_notifications_enabled = coalesce(p_push_notifications_enabled, push_notifications_enabled),
         updated_at = now()
   where id = auth.uid()
   returning * into v_result;

  if not found then
    raise exception 'Profile not found';
  end if;

  -- Return ONLY non-sensitive fields. `role` is included read-only so the UI can
  -- refresh its view, but it can never be WRITTEN by this call.
  return jsonb_build_object(
    'id', v_result.id,
    'first_name', v_result.first_name,
    'last_name', v_result.last_name,
    'full_name', v_result.full_name,
    'phone_number', v_result.phone_number,
    'push_notifications_enabled', v_result.push_notifications_enabled,
    'role', upper(coalesce(v_result.role, '')),
    'role_version', coalesce(v_result.role_version, 1)
  );
end;
$$;

comment on function public.update_my_profile(text, text, text, boolean) is
  'Scenario 16: the ONLY sanctioned self-update path. Accepts only safe fields, so a malicious client cannot smuggle `role` into the payload. Role is returned read-only.';

revoke all on function public.update_my_profile(text, text, text, boolean) from public;
grant execute on function public.update_my_profile(text, text, text, boolean) to authenticated;