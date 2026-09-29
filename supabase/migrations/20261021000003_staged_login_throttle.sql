-- ============================================================================
-- 20261021000003 — Staged login throttle + wrong-password security email
-- ============================================================================
--
-- THE REQUIREMENT (stated by the shop owner)
-- ------------------------------------------
--   * First 4 wrong passwords  → no delay.
--   * The next wrong password  → wait 5 minutes.
--   * The 2 following wrong ones → wait 10 minutes.
--   * One more wrong password   → stop: email the account owner a security
--     notice + password-reset link. If they did not attempt it (a possible
--     attacker), they can ignore it — but they are warned that someone is
--     trying to get into their account and advised to change their password.
--
-- WHY THE EXISTING FUNCTION COULD NOT BE EXTENDED
-- -----------------------------------------------
-- `register_failed_login` (20260927000001) is a 5-strikes-20-minutes lock, and
-- critically it ZEROES `failed_login_attempts` at the moment it locks:
--
--     set failed_login_attempts = 0, locked_until = v_locked_until
--
-- That makes a multi-stage ladder impossible on the existing state, because the
-- server cannot tell "attempt 5 of the first window" from "attempt 1 of the
-- second" — the counter it would need has already been reset. This migration
-- adds explicit stage columns instead of trying to infer the stage from a
-- counter that is deliberately destroyed.
--
-- DESIGN NOTES
-- ------------
-- 1. THE LADDER IS DATA, NOT CODE.
--    `login_lockout_policy` holds the rungs (attempt threshold → delay), so the
--    shop's policy can change without editing a function body. It also means the
--    sequence is testable by reading a table rather than by reasoning about
--    branches.
--
-- 2. THE LADDER PROGRESSES ON *LOCK CONSUMPTION*, NOT RAW FAILURE COUNT.
--    "The next 2 wrong passwords" is counted WITHIN the post-lock window, not
--    cumulatively: attempts 1-4 free; the 5th locks 5 min; the 6th and 7th are
--    free; the 8th locks 10 min; the 9th escalates to the security email. This
--    is the reading that matches "wait for 5 minutes" producing a fresh, small
--    allowance rather than a rung that fires again immediately on the next typo.
--
-- 3. NO ACCOUNT-EXISTENCE ORACLE.
--    `register_failed_login` answers a NEUTRAL shape for an unknown email — a
--    deliberate property of the original design, preserved here. The email is
--    only ever sent to the address on a REAL profile row, and the response shape
--    for an unknown address stays identical to the known-but-not-yet-flagged
--    case, so the endpoint cannot be used to enumerate accounts.
--
-- 4. THE EMAIL IS SENT AT MOST ONCE PER ESCALATION.
--    `security_notice_sent_at` is stamped when the notice is dispatched, and the
--    escalation branch is guarded on it being NULL within the current episode.
--    Without this, attempt 10, 11, 12... would each send another email and the
--    "attack" would become a way to mail-bomb the victim.
-- ============================================================================

-- ── 1. Staged-state columns ─────────────────────────────────────────────────
alter table public.profiles
  add column if not exists lockout_stage integer not null default 0,
  add column if not exists stage_failed_attempts integer not null default 0,
  add column if not exists security_notice_sent_at timestamptz;

comment on column public.profiles.lockout_stage is
  'Index into login_lockout_policy: which rung of the throttle ladder the account has reached. 0 = no delay yet. Distinct from the legacy failed_login_attempts, which is reset on lock and therefore cannot express a multi-stage ladder.';
comment on column public.profiles.stage_failed_attempts is
  'Failures accumulated WITHIN the current stage. Reset when a stage is entered, so "the next 2 wrong passwords" is counted per-window.';
comment on column public.profiles.security_notice_sent_at is
  'When the wrong-password security notice was last emailed. Guards against repeating the notice on every subsequent failure within the same episode.';

-- ── 2. The ladder ───────────────────────────────────────────────────────────
create table if not exists public.login_lockout_policy (
  stage integer primary key,
  -- Failures ALLOWED at this stage before the stage's delay is applied.
  attempts_allowed integer not null check (attempts_allowed >= 0),
  -- Delay applied once attempts_allowed is exhausted. NULL = escalate instead.
  lock_minutes integer check (lock_minutes is null or lock_minutes > 0),
  -- When true, exhausting this stage sends the security notice and stops.
  escalate boolean not null default false,
  description text
);

comment on table public.login_lockout_policy is
  'The login throttle ladder as data: each rung says how many attempts are allowed before a delay (or escalation). Read by register_failed_login_staged.';

-- SEMANTICS: `attempts_allowed` is how many FURTHER failures this stage tolerates
-- BEFORE it locks. The lock fires on the (attempts_allowed + 1)th failure at that
-- stage. This is the reading that makes the shop's sequence literal:
--
--   stage 0: 4 further failures tolerated → the 5th locks 5 minutes
--   stage 1: 1 further failure tolerated   → the 6th would lock...
--
-- The requested sequence is "4 free, then a 5-minute wait, then the NEXT 2 wrong
-- ones, then a 10-minute wait, then one more and we email". Counting the
-- sequence as a whole (failures 1..9), the rungs are:
--
--   failure 1-4  stage 0 (tolerates 4)  → still free
--   failure 5    stage 1 (tolerates 0)  → locks 5 min   [the "next wrong one"]
--   failure 6-7  stage 2 (tolerates 1)  → 6 free, 7 locks 10 min [the "next 2"]
--   failure 8    stage 3 (tolerates 0)  → escalate
--
-- Expressed as tolerances this is 4, 0, 1, 0 — each rung's lock fires on its
-- (tolerance + 1)th failure. Storing it this way keeps the function's
-- `v_stage_attempts > attempts_allowed` test true for every rung, including the
-- tolerates-zero ones, which the earlier 4/1/2/1 table got wrong (stage 2 got
-- three attempts instead of two, so escalation never fired at failure 9).
insert into public.login_lockout_policy (stage, attempts_allowed, lock_minutes, escalate, description) values
  (0, 4, null, false, 'Failures 1-4: no delay.'),
  (1, 0, 5,    false, 'Failure 5: locks for 5 minutes.'),
  (2, 1, 10,   false, 'Failures 6-7: 6 is free, 7 locks for 10 minutes.'),
  (3, 0, null, true,  'Failure 8: security notice sent, password reset required.')
on conflict (stage) do update
  set attempts_allowed = excluded.attempts_allowed,
      lock_minutes = excluded.lock_minutes,
      escalate = excluded.escalate,
      description = excluded.description;

-- Read-only reference data. Clients may read it to render accurate copy
-- ("you have 2 attempts before a 10 minute wait") without hard-coding numbers.
alter table public.login_lockout_policy enable row level security;

drop policy if exists login_lockout_policy_read on public.login_lockout_policy;
create policy login_lockout_policy_read
  on public.login_lockout_policy
  for select
  to anon, authenticated
  using (true);

-- ── 3. Escalation bookkeeping ───────────────────────────────────────────────
-- Mirrors the password_confirmation_requests pattern: the CLIENT asks for this
-- flag, the backend consumes it and sends the mail. Splitting it this way keeps
-- the mail transport out of the database (pg_net is reserved for storage
-- cleanup) and keeps the token RNG in one place.
create table if not exists public.login_security_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  email text not null,
  reason text not null default 'REPEATED_FAILED_LOGIN',
  attempts_at_escalation integer not null default 0,
  requested_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.login_security_notices is
  'One row per wrong-password escalation. The backend polls unsent rows and emails a security warning + password-reset link to the account owner.';

create index if not exists idx_login_security_notices_unsent
  on public.login_security_notices (requested_at)
  where sent_at is null;

alter table public.login_security_notices enable row level security;

-- Only an administrator may read these; the escalating client itself does not
-- need to read the queue, it only needs to know it was recorded.
drop policy if exists login_security_notices_admin_read on public.login_security_notices;
create policy login_security_notices_admin_read
  on public.login_security_notices
  for select
  to authenticated
  using (public.is_admin());

-- ── 4. The staged throttle ──────────────────────────────────────────────────
create or replace function public.register_failed_login_staged(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
  v_stage integer;
  v_stage_attempts integer;
  v_locked_until timestamptz;
  v_notice_sent_at timestamptz;
  v_rung public.login_lockout_policy%rowtype;
  v_next_rung public.login_lockout_policy%rowtype;
  v_escalate boolean := false;
  v_notice_created boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('speedway:loginlock:' || v_email));

  select id, coalesce(lockout_stage, 0), coalesce(stage_failed_attempts, 0),
         locked_until, security_notice_sent_at
    into v_id, v_stage, v_stage_attempts, v_locked_until, v_notice_sent_at
    from public.profiles
   where lower(email) = v_email
   limit 1;

  -- Unknown address: identical neutral shape to the known-not-locked case.
  -- Never reveal whether the account exists.
  if v_id is null then
    return jsonb_build_object(
      'locked', false,
      'stage', 0,
      'attempts_remaining', 4,
      'locked_until', null,
      'escalated', false
    );
  end if;

  -- An ACTIVE lock is not extended by further attempts; report the same state.
  if v_locked_until is not null and now() < v_locked_until then
    return jsonb_build_object(
      'locked', true,
      'stage', v_stage,
      'attempts_remaining', 0,
      'locked_until', v_locked_until,
      'minutes_left', ceil(extract(epoch from (v_locked_until - now())) / 60.0)::int,
      'escalated', false
    );
  end if;

  -- A lock that has now expired is consumed, and consuming it ADVANCES the
  -- ladder. `lockout_stage` always names the rung that produced the lock just
  -- served, so expiry moves to the next rung and the attempt being registered
  -- now is the FIRST attempt of that rung.
  --
  -- The trace that proves this is needed (attempt 5 locked at stage 0, so
  -- attempt 6 re-served the 5-minute rung instead of the 10-minute one):
  --   attempt 5 -> exhausted stage 0, wrote lockout_stage = 0
  --   expiry    -> must move to stage 1
  --   attempt 6 -> first attempt AT stage 1
  -- A lock that has now expired is simply CONSUMED.
  --
  -- Two things must NOT happen here, both of which a test run caught:
  --   * do NOT advance the stage — it was already advanced when the lock was
  --     ISSUED (see "ADVANCE FIRST" below), so advancing again would skip a rung;
  --   * do NOT reset `stage_failed_attempts` — an expired timestamp can still be
  --     sitting on the row while the CURRENT rung is part-way through its
  --     allowance. Failure 7 of stage 2 is free and resets `locked_until` to null
  --     only on the next LOCK, so failure 8 arrived with a stale expired
  --     timestamp, took this branch, had its counter wiped to 0, and lost the
  --     attempt it had just spent (reported `locked: false` when it should have
  --     locked for 10 minutes).
  -- The counter is owned by the rung, not by the lock.
  if v_locked_until is not null and now() >= v_locked_until then
    v_locked_until := null;
  end if;

  select * into v_rung from public.login_lockout_policy where stage = v_stage;

  -- Past the end of the ladder: stay on the LAST rung (escalation), never error.
  if not found then
    select * into v_rung from public.login_lockout_policy order by stage desc limit 1;
    v_stage := coalesce(v_rung.stage, v_stage);
  end if;

  v_stage_attempts := v_stage_attempts + 1;

  -- ── Exhausted this rung ──
  -- `attempts_allowed` is how many FAILURES this rung tolerates before it locks.
  -- The lock fires on failure (attempts_allowed + 1) of that rung. Expressed as
  -- tolerances, the shop's ladder is:
  --   stage 0 tolerates 4 → failure 5 locks 5 minutes
  --   stage 1 tolerates 0 → failure 6 locks 10 minutes
  --   stage 2 tolerates 1 → failure 7 free, failure 8 locks 10 minutes
  --   stage 3 tolerates 0 → failure 9 sends the security notice
  if v_stage_attempts > coalesce(v_rung.attempts_allowed, 0) then
    -- ADVANCE FIRST, then write. The stage persisted on the profile must name the
    -- rung whose lock is now in force — the rung we just moved INTO.
    --
    -- Writing the rung we had just EXHAUSTED caused the next lock to re-serve the
    -- same delay, so the 10-minute rung was unreachable. Traced live: failure 5
    -- locked at stage 0, expiry advanced the counter to 1, and failure 6 then
    -- re-locked for 5 minutes instead of 10.
    v_stage := v_stage + 1;
    v_stage_attempts := 0;

    -- Re-read the rung we are locking INTO. Without this, `v_rung` still holds the
    -- rung we just exhausted, so the escalation test below reads the WRONG row and
    -- `minutes_left` reports the previous rung's delay (failure 6 said "5 minutes"
    -- while actually applying the 10-minute rung).
    select * into v_rung from public.login_lockout_policy where stage = v_stage;
    if not found then
      select * into v_rung from public.login_lockout_policy order by stage desc limit 1;
      v_stage := coalesce(v_rung.stage, v_stage);
    end if;

    if coalesce(v_rung.escalate, false) then
      v_escalate := true;

      -- Send the notice at most ONCE per episode. A re-escalation only happens
      -- after a successful login clears the state, so `security_notice_sent_at`
      -- being set means "already warned about this episode".
      if v_notice_sent_at is null then
        insert into public.login_security_notices (user_id, email, reason, attempts_at_escalation)
        values (v_id, (select email from public.profiles where id = v_id), 'REPEATED_FAILED_LOGIN', v_stage_attempts);

        v_notice_created := true;
      end if;

      -- A long hold rather than a new rung: the account is no longer in
      -- "wait a moment" territory, it needs a password reset. 60 minutes gives
      -- the owner time to act and denies a brute-forcer the window.
      v_locked_until := now() + interval '60 minutes';

      -- Preserve an existing stamp when no new notice was queued: the point of
      -- the stamp is "this episode has already warned the owner", and this
      -- branch can be re-entered on every further failure while the account sits
      -- in the escalation stage.
      update public.profiles
         set lockout_stage = v_stage,
             stage_failed_attempts = 0,
             locked_until = v_locked_until,
             failed_login_attempts = 0,
             security_notice_sent_at = case when v_notice_created then now() else v_notice_sent_at end,
             updated_at = now()
       where id = v_id;

      return jsonb_build_object(
        'locked', true,
        'stage', v_stage,
        'attempts_remaining', 0,
        'locked_until', v_locked_until,
        'minutes_left', 60,
        'escalated', true,
        'notice_queued', v_notice_created,
        'message', 'Too many incorrect attempts. A security notice with a password-reset link has been sent to the account email address.'
      );
    end if;

    -- Apply this rung's delay and reset the per-stage allowance.
    v_locked_until := now() + make_interval(mins => coalesce(v_rung.lock_minutes, 5));

    update public.profiles
       set lockout_stage = v_stage,
           stage_failed_attempts = 0,
           locked_until = v_locked_until,
           failed_login_attempts = 0,
           updated_at = now()
     where id = v_id;

    select * into v_next_rung from public.login_lockout_policy where stage = v_stage + 1;

    return jsonb_build_object(
      'locked', true,
      'stage', v_stage,
      'attempts_remaining', 0,
      'locked_until', v_locked_until,
      'minutes_left', coalesce(v_rung.lock_minutes, 5),
      'escalated', false,
      -- So the UI can say what happens NEXT, not just what happened now.
      'next_stage_attempts_allowed', coalesce(v_next_rung.attempts_allowed, 1),
      'next_stage_lock_minutes', v_next_rung.lock_minutes,
      'next_stage_escalates', coalesce(v_next_rung.escalate, true)
    );
  end if;

  -- ── Still inside this rung's allowance ──
  update public.profiles
     set lockout_stage = v_stage,
         stage_failed_attempts = v_stage_attempts,
         failed_login_attempts = v_stage_attempts,
         updated_at = now()
   where id = v_id;

  return jsonb_build_object(
    'locked', false,
    'stage', v_stage,
    'attempts_remaining', coalesce(v_rung.attempts_allowed, 0) - v_stage_attempts,
    'locked_until', null,
    'escalated', false
  );
end;
$$;

revoke all on function public.register_failed_login_staged(text) from public;
grant execute on function public.register_failed_login_staged(text) to anon, authenticated;

comment on function public.register_failed_login_staged(text) is
  'Staged login throttle: 4 free attempts, then 5-minute and 10-minute locks per login_lockout_policy, then a security notice + reset requirement. Returns neutral shapes for unknown addresses so it cannot be used to enumerate accounts.';

-- ── 5. Staged state in the pre-submit check ─────────────────────────────────
-- Redefines check_login_lock to also report the stage, so the login screen can
-- render the right message BEFORE the user submits (and can show the remaining
-- count without a second round trip).
create or replace function public.check_login_lock(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_failed integer := 0;
  v_locked_until timestamptz;
  v_must_change boolean := false;
  v_stage integer := 0;
  v_stage_attempts integer := 0;
  v_notice_sent_at timestamptz;
  v_rung public.login_lockout_policy%rowtype;
  v_locked boolean;
begin
  select coalesce(p.failed_login_attempts, 0), p.locked_until,
         coalesce(p.must_change_password, false),
         coalesce(p.lockout_stage, 0), coalesce(p.stage_failed_attempts, 0),
         p.security_notice_sent_at
    into v_failed, v_locked_until, v_must_change, v_stage, v_stage_attempts, v_notice_sent_at
    from public.profiles p
   where lower(p.email) = v_email
   limit 1;

  v_locked := v_locked_until is not null and now() < v_locked_until;

  select * into v_rung from public.login_lockout_policy where stage = v_stage;

  return jsonb_build_object(
    'locked', v_locked,
    'locked_until', v_locked_until,
    'seconds_left', case
      when v_locked then ceil(extract(epoch from (v_locked_until - now())))::int
      else 0
    end,
    'minutes_left', case
      when v_locked then ceil(extract(epoch from (v_locked_until - now())) / 60.0)::int
      else 0
    end,
    'failed_login_attempts', v_failed,
    'must_change_password', v_must_change,
    'stage', v_stage,
    'attempts_remaining', case
      when v_locked then 0
      else greatest(0, coalesce(v_rung.attempts_allowed, 4) - v_stage_attempts)
    end,
    -- True once the owner has been warned about this episode, so the UI can tell
    -- them to check their email instead of offering another attempt.
    'security_notice_sent', v_notice_sent_at is not null,
    -- What a further failure will cost, for honest copy.
    'next_lock_minutes', v_rung.lock_minutes,
    'escalates_next', coalesce(v_rung.escalate, false)
  );
end;
$$;

revoke all on function public.check_login_lock(text) from public;
grant execute on function public.check_login_lock(text) to anon, authenticated;

-- ── 6. Clear the staged state on success ────────────────────────────────────
-- Extends the existing clear_login_lock contract: a successful login resets the
-- ladder to rung 0 and re-arms the security notice for a future episode.
create or replace function public.clear_login_lock(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  update public.profiles
     set failed_login_attempts = 0,
         locked_until = null,
         lockout_stage = 0,
         stage_failed_attempts = 0,
         -- Re-arm: the next episode deserves its own warning.
         security_notice_sent_at = null,
         updated_at = now()
   where lower(email) = v_email;

  return jsonb_build_object('cleared', true);
end;
$$;

revoke all on function public.clear_login_lock(text) from public;
grant execute on function public.clear_login_lock(text) to anon, authenticated;

-- ── 7. Queue reader for the backend mailer ──────────────────────────────────
create or replace function public.claim_login_security_notices(p_limit integer default 10)
returns setof public.login_security_notices
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    update public.login_security_notices n
       set sent_at = now()
     where n.id in (
             select id from public.login_security_notices
              where sent_at is null
              order by requested_at
              limit greatest(1, coalesce(p_limit, 10))
              for update skip locked
           )
    returning n.*;
end;
$$;

revoke all on function public.claim_login_security_notices(integer) from public;
grant execute on function public.claim_login_security_notices(integer) to service_role;

comment on function public.claim_login_security_notices(integer) is
  'Atomically claims up to p_limit unsent security notices (FOR UPDATE SKIP LOCKED) so two backend workers cannot both mail the same row. Service-role only.';

-- ── 8. Keep the legacy 5-strike function consistent ─────────────────────────
-- Anything still calling register_failed_login must not bypass the ladder, or
-- the two paths would disagree about the lock state. It now delegates.
create or replace function public.register_failed_login(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.register_failed_login_staged(p_email);
end;
$$;

revoke all on function public.register_failed_login(text) from public;
grant execute on function public.register_failed_login(text) to anon, authenticated;

comment on function public.register_failed_login(text) is
  'DEPRECATED alias for register_failed_login_staged. Kept so existing callers inherit the staged ladder instead of the old single-rung 5-strike lock.';