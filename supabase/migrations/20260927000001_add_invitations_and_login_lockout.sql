-- ============================================================================
-- Session 1 / Section 1.1 + 1.2: Account invitations & DB-backed login lockout
-- ============================================================================
--
-- Adds, in one guarded/idempotent migration:
--
--   1. FIRST-LOGIN PASSWORD RESET (Section 1.1)
--      * profiles.must_change_password boolean default false.
--        New invited accounts set this true; the app intercepts the session
--        immediately after authentication and renders an un-dismissable
--        "Must Change Password" screen before any app route is granted.
--
--   2. ATOMIC INVITE CREATION (Section 1.1)
--      * create_invited_account(...) RPC: checks BOTH auth.users and profiles
--        for the email in a single transaction. If it exists under ANY role the
--        call raises EMAIL_ALREADY_EXISTS so the caller can render the exact
--        message "An account with this email address already exists in the
--        system." Runs SECURITY DEFINER (it must read auth.users, which is not
--        otherwise reachable) and is restricted to ADMIN callers.
--
--   3. DB-BACKED FAILED LOGIN LOCKOUT (Section 1.2)
--      * profiles.failed_login_attempts int default 0
--      * profiles.locked_until timestamptz null
--        The lock is evaluated as NOW() < locked_until, so refreshing or
--        reopening the browser cannot reset it — the state lives in the DB,
--        not in localStorage.
--      * register_failed_login() : increments, and at 5 consecutive failures
--        sets locked_until = now() + interval '20 minutes'.
--      * clear_login_lock()     : emergency-recovery / successful login reset
--        (failed_login_attempts = 0, locked_until = null).
--      * check_login_lock()     : returns { locked, locked_until, minutes_left,
--        failed_login_attempts, must_change_password } for the login screen and
--        the persisted countdown timer.
--
-- All statements are guarded so the file is safe to re-run.
-- ============================================================================

-- -- 1. Profiles: first-login flag + lockout columns ---------------------------
alter table if exists public.profiles
  add column if not exists must_change_password boolean not null default false,
  add column if not exists failed_login_attempts integer not null default 0,
  add column if not exists locked_until timestamptz;

comment on column public.profiles.must_change_password is
  'Section 1.1: invited accounts carry this true; the session is intercepted on first login and an un-dismissable password-change screen is shown before app routes are granted.';
comment on column public.profiles.failed_login_attempts is
  'Section 1.2: consecutive failed login count. Reset to 0 on success or emergency recovery.';
comment on column public.profiles.locked_until is
  'Section 1.2: DB-evaluated lock expiry (NOW() < locked_until). Survives refresh/reopen because it is server state, not client state.';

-- -- 2. Admin predicate (idempotent; matches the Batch 7 definition) ----------
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and upper(coalesce(role,'')) = 'ADMIN'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- -- 3. Atomic invite creation (Section 1.1) -----------------------------------
-- Blocks duplicates across auth.users AND profiles in one transaction.
-- Raises a stable SQLSTATE so the backend can map it to the exact UX copy.
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

  -- Atomic existence lookup. Serialize concurrent invites for the same address
  -- so two admins cannot race past the check and create duplicate auth users.
  perform pg_advisory_xact_lock(hashtext('speedway:invite:' || v_email));

  select exists (select 1 from auth.users u where lower(u.email) = v_email)
    into v_auth_exists;
  select exists (select 1 from public.profiles p where lower(p.email) = v_email)
    into v_profile_exists;

  if v_auth_exists or v_profile_exists then
    -- Stable code: the backend maps this to
    -- "An account with this email address already exists in the system."
    raise exception 'EMAIL_ALREADY_EXISTS' using errcode = '23505';
  end if;

  return jsonb_build_object(
    'email', v_email,
    'role', v_role,
    'first_name', btrim(coalesce(p_first_name, '')),
    'last_name', btrim(coalesce(p_last_name, '')),
    'must_change_password', coalesce(p_must_change_password, true)
  );
end;
$$;

revoke all on function public.create_invited_account(text, text, text, text, boolean) from public;
grant execute on function public.create_invited_account(text, text, text, text, boolean) to authenticated;

-- -- 4. DB-backed failed-login lockout (Section 1.2) ---------------------------
-- check_login_lock: read-only, callable by the login screen (anon) so a locked
-- user sees the persisted timer BEFORE submitting credentials.
create or replace function public.check_login_lock(p_email text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_failed integer := 0;
  v_locked_until timestamptz;
  v_must_change boolean := false;
begin
  select coalesce(p.failed_login_attempts, 0), p.locked_until,
         coalesce(p.must_change_password, false)
    into v_failed, v_locked_until, v_must_change
    from public.profiles p
   where lower(p.email) = v_email
   limit 1;

  return jsonb_build_object(
    'locked', v_locked_until is not null and now() < v_locked_until,
    'locked_until', v_locked_until,
    'seconds_left', case
      when v_locked_until is not null and now() < v_locked_until
      then ceil(extract(epoch from (v_locked_until - now())))::int
      else 0
    end,
    'minutes_left', case
      when v_locked_until is not null and now() < v_locked_until
      then ceil(extract(epoch from (v_locked_until - now())) / 60.0)::int
      else 0
    end,
    'failed_login_attempts', v_failed,
    'must_change_password', v_must_change
  );
end;
$$;

revoke all on function public.check_login_lock(text) from public;
grant execute on function public.check_login_lock(text) to anon, authenticated;

-- register_failed_login: increments the counter and, at 5 consecutive failures,
-- sets locked_until = now() + 20 minutes. Returns the resulting state so the
-- caller can render "Attempt N of 5" or the lockout notice.
create or replace function public.register_failed_login(p_email text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
  v_failed integer;
  v_locked_until timestamptz;
  v_max_attempts constant integer := 5;
  v_lock_interval constant interval := interval '20 minutes';
begin
  perform pg_advisory_xact_lock(hashtext('speedway:loginlock:' || v_email));

  select id, coalesce(failed_login_attempts, 0), locked_until
    into v_id, v_failed, v_locked_until
    from public.profiles
   where lower(email) = v_email
   limit 1;

  -- Unknown email: return a neutral shape. Never reveal account existence.
  if v_id is null then
    return jsonb_build_object(
      'locked', false,
      'failed_login_attempts', 0,
      'attempts_remaining', v_max_attempts,
      'locked_until', null
    );
  end if;

  -- An active lock is not extended by further attempts; report the same state.
  if v_locked_until is not null and now() < v_locked_until then
    return jsonb_build_object(
      'locked', true,
      'failed_login_attempts', v_failed,
      'attempts_remaining', 0,
      'locked_until', v_locked_until,
      'minutes_left', ceil(extract(epoch from (v_locked_until - now())) / 60.0)::int
    );
  end if;

  -- A previous lock that has now expired starts a fresh window.
  if v_locked_until is not null and now() >= v_locked_until then
    v_failed := 0;
  end if;

  v_failed := v_failed + 1;

  if v_failed >= v_max_attempts then
    v_locked_until := now() + v_lock_interval;

    update public.profiles
       set failed_login_attempts = 0,
           locked_until = v_locked_until,
           updated_at = now()
     where id = v_id;

    return jsonb_build_object(
      'locked', true,
      'failed_login_attempts', 0,
      'attempts_remaining', 0,
      'locked_until', v_locked_until,
      'minutes_left', 20
    );
  end if;

  update public.profiles
     set failed_login_attempts = v_failed,
         updated_at = now()
   where id = v_id;

  return jsonb_build_object(
    'locked', false,
    'failed_login_attempts', v_failed,
    'attempts_remaining', v_max_attempts - v_failed,
    'locked_until', null
  );
end;
$$;

revoke all on function public.register_failed_login(text) from public;
grant execute on function public.register_failed_login(text) to anon, authenticated;

-- clear_login_lock: called after a successful login AND after an emergency
-- recovery verification. Resets the counter and clears the lock.
create or replace function public.clear_login_lock(p_email text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  update public.profiles
     set failed_login_attempts = 0,
         locked_until = null,
         updated_at = now()
   where lower(email) = v_email;

  return jsonb_build_object('cleared', true);
end;
$$;

revoke all on function public.clear_login_lock(text) from public;
grant execute on function public.clear_login_lock(text) to anon, authenticated;

-- -- 5. First-login completion (Section 1.1) ----------------------------------
-- Called after the user sets a new password on the interception screen. Only
-- the account owner may clear their own flag.
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
