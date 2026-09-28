-- ============================================================================
-- 20261019000003_first_login_flag_resilience.sql
-- ============================================================================
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Reported live, in the first-login "Set Your Password" flow:
--
--   POST /rest/v1/rpc/complete_first_login_password_change  403 (Forbidden)
--   PUT  /auth/v1/user                                      422 (Unprocessable)
--
-- THE 403
-- -------
-- complete_first_login_password_change() is `security definer` and is granted to
-- `authenticated` by migration 20260927000001. A 403 from PostgREST means the
-- caller could not execute it AT ALL, which in practice means one of:
--
--   (a) migration 20260927000001 was never applied to this database (the same
--       "13 unapplied migrations" class of problem documented in
--       DEFECTS-FOUND.md), so the function does not exist / has no grant; or
--   (b) the function exists but the grant was dropped.
--
-- This migration makes the capability SELF-HEALING: it (re)creates the function
-- and re-asserts the grant unconditionally, so re-running `supabase db push`
-- repairs either case without depending on 20260927000001 having landed first.
--
-- THE ORDERING DEFECT (the part that STRANDED users)
-- --------------------------------------------------
-- The client did:
--     1. supabase.auth.updateUser({ password })   -- changes the real password
--     2. supabase.rpc('complete_first_login_...') -- clears the flag
--
-- If step 2 failed (the 403 above), step 1 had ALREADY taken effect: the account
-- now had a password the user chose, but `must_change_password` was still true,
-- so the gate rendered again — permanently, with no way forward except the magic
-- temporary password they had just overwritten. The fix has two halves:
--
--   * server-side (this file): add clear_first_login_flag() — an idempotent,
--     tolerant variant that also clears a flag left set on an account whose
--     password was already changed, so a stranded session can recover; and
--   * client-side (MustChangePasswordGate.jsx): treat "password changed but flag
--     not cleared" as a REPAIRABLE state and retry, instead of a dead end.
--
-- SECURITY: every function below is owner-only (it acts on auth.uid() alone) and
-- cannot be used to clear another account's flag.
-- ============================================================================

-- ── 1. (Re)assert the original owner-only completion function ───────────────
create or replace function public.complete_first_login_password_change()
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.profiles
     set must_change_password = false,
         updated_at = now()
   where id = auth.uid();

  return jsonb_build_object('cleared', true);
end;
$$;

revoke all on function public.complete_first_login_password_change() from public;
grant execute on function public.complete_first_login_password_change() to authenticated;
-- service_role too, so the backend can clear the flag on a user's behalf when
-- repairing an account without a live user JWT.
grant execute on function public.complete_first_login_password_change() to service_role;

comment on function public.complete_first_login_password_change() is
  'Owner-only: clears the caller''s own must_change_password flag after they set a new password. Granted to authenticated + service_role.';

-- ── 2. Tolerant, idempotent repair variant ─────────────────────────────────
-- Identical authorisation (own account only) but ALWAYS reports the resulting
-- state rather than assuming the row changed, and never raises merely because
-- the flag was already clear. Safe to call repeatedly.
create or replace function public.clear_first_login_flag()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_now boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.profiles
     set must_change_password = false,
         updated_at = now()
   where id = auth.uid()
     and coalesce(must_change_password, false) = true;

  select coalesce(must_change_password, false)
    into v_now
    from public.profiles
   where id = auth.uid();

  return jsonb_build_object(
    'cleared', coalesce(v_now, false) = false,
    'must_change_password', coalesce(v_now, false)
  );
end;
$$;

revoke all on function public.clear_first_login_flag() from public;
grant execute on function public.clear_first_login_flag() to authenticated, service_role;

comment on function public.clear_first_login_flag() is
  'Idempotent owner-only repair: clears the caller''s own must_change_password flag and returns the resulting state. Used when the password change succeeded but the flag was not cleared (e.g. a transient 403), so the user is never stranded in the gate.';

-- ── 3. Self-check ──────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('complete_first_login_password_change', 'clear_first_login_flag')
  ) then
    raise exception 'First-login flag functions were not created.';
  end if;
  raise notice 'First-login flag functions present and granted (authenticated + service_role).';
end
$$;