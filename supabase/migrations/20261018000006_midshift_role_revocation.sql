-- ============================================================================
-- Batch 1 Additions — Scenario 13: Mid-Shift Role Revocation (Access & Cascade)
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- A super-admin demotes a STAFF member to CUSTOMER (or revokes access) while
-- that member is mid-shift, processing a walk-in booking and chatting.
--
-- The GOOD news already in place: `public.is_admin()` reads the LIVE
-- profiles.role (not the JWT claim), so the very next privileged call after a
-- demotion is correctly denied. Historical rows are safe because the demotion
-- is a role UPDATE, never a delete — bookings.staff_id, audit_logs.actor_id and
-- booking_messages.sender_id keep pointing at the same profile row, so no FK is
-- broken and no history is lost.
--
-- The GAPS this migration closes:
--
--   1. `is_admin()` ignored `is_active`. A soft-deleted/deactivated account
--      still holding an unexpired JWT could keep exercising admin RPCs.
--
--   2. There was no `is_staff_or_admin()` predicate, so staff-scoped RLS
--      policies were written ad hoc and could not be centrally revoked.
--
--   3. No revocation SIGNAL. A demoted user's browser kept a stale role in
--      memory and only discovered the change on the next failed call, mid-action
--      (e.g. half-way through confirming a walk-in). We add a monotonic
--      `role_version` on profiles plus `my_access_context()`, so the client can
--      cheaply detect "my access changed" and boot to login gracefully.
-- ============================================================================

-- ── 0. role_version column ──────────────────────────────────────────────────
alter table public.profiles
  add column if not exists role_version integer not null default 1;

comment on column public.profiles.role_version is
  'Scenario 13: monotonic counter bumped on every role/active-state change. Clients compare it to detect a mid-session revocation and boot to login.';

-- Bump role_version whenever role or is_active changes.
create or replace function public.bump_role_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.role is distinct from old.role)
     or (coalesce(new.is_active, true) is distinct from coalesce(old.is_active, true)) then
    new.role_version := coalesce(old.role_version, 1) + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bump_role_version on public.profiles;
create trigger trg_bump_role_version
  before update on public.profiles
  for each row
  execute function public.bump_role_version();

comment on function public.bump_role_version() is
  'Scenario 13: advances profiles.role_version whenever role or is_active changes, giving the frontend a reliable revocation signal.';


-- ── 1. Harden is_admin() to require an ACTIVE account ───────────────────────
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and upper(coalesce(role, '')) = 'ADMIN'
       and coalesce(is_active, true) = true
  );
$$;

comment on function public.is_admin() is
  'Scenario 13: TRUE only for an ACTIVE ADMIN. Reads the LIVE profiles.role (never the JWT claim), so a demotion or deactivation takes effect on the very next privileged call.';

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;


-- ── 2. Staff-or-admin predicate ─────────────────────────────────────────────
create or replace function public.is_staff_or_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and upper(coalesce(role, '')) in ('STAFF', 'ADMIN')
       and coalesce(is_active, true) = true
  );
$$;

comment on function public.is_staff_or_admin() is
  'Scenario 13: TRUE only for an ACTIVE STAFF or ADMIN. Shared predicate so staff RLS can be revoked centrally by demotion or deactivation.';

revoke all on function public.is_staff_or_admin() from public;
grant execute on function public.is_staff_or_admin() to authenticated;


-- ── 3. Access-context probe for the client ──────────────────────────────────
-- A tiny, cheap call the frontend can poll (or call on focus / after any 403) to
-- learn whether its cached role is still valid. Returns the LIVE role, active
-- flag and version — never the stale JWT claim.
create or replace function public.my_access_context()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object(
              'id', p.id,
              'role', upper(coalesce(p.role, '')),
              'is_active', coalesce(p.is_active, true),
              'role_version', coalesce(p.role_version, 1)
            )
       from public.profiles p
      where p.id = auth.uid()),
    jsonb_build_object('id', null, 'role', 'ANON', 'is_active', false, 'role_version', 0)
  );
$$;

comment on function public.my_access_context() is
  'Scenario 13: returns the caller''s LIVE role/is_active/role_version. The client compares role_version to its cached value to detect a mid-session revocation and redirect to login without an error loop.';

revoke all on function public.my_access_context() from public;
grant execute on function public.my_access_context() to authenticated;


-- ── 4. Cascade-safe revoke_access RPC (role + optional deactivate) ───────────
-- Keeps the seal-in-SQL approach: the demotion and the audit entry happen in ONE
-- transaction, the last-admin guard is enforced here too (defence in depth), and
-- historical rows are never touched — only the profile's role/active state.
create or replace function public.revoke_staff_access(
  p_member_id uuid,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_admin_count integer;
  v_actor uuid := coalesce(p_actor_id, auth.uid());
begin
  if not public.is_admin() then
    raise exception 'Only administrators may revoke access';
  end if;

  select * into v_profile from public.profiles where id = p_member_id for update;
  if not found then
    raise exception 'Member not found';
  end if;

  -- Last-admin guard (mirrors the backend check).
  if upper(coalesce(v_profile.role, '')) = 'ADMIN' then
    select count(*) into v_admin_count
      from public.profiles
     where upper(coalesce(role, '')) = 'ADMIN'
       and coalesce(is_active, true) = true;
    if v_admin_count <= 1 then
      raise exception 'This is the last remaining administrator account and cannot be revoked.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- HISTORICAL INTEGRITY: an UPDATE only. bookings.staff_id / audit_logs.actor_id
  -- keep referencing this same row, so nothing relational breaks.
  update public.profiles
     set role = 'CUSTOMER',
         updated_at = now()
   where id = p_member_id;

  insert into public.audit_logs (
    action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    'REVOKE_ACCESS',
    format('Account access revoked for %s. Role downgraded from %s to CUSTOMER.',
           coalesce(v_profile.full_name, v_profile.email), coalesce(v_profile.role, 'STAFF')),
    coalesce((select full_name from public.profiles where id = v_actor), 'Administrator'),
    'ADMIN', v_actor,
    jsonb_build_object('member_id', p_member_id, 'old_role', v_profile.role, 'new_role', 'CUSTOMER')
  );

  return jsonb_build_object(
    'member_id', p_member_id,
    'old_role', v_profile.role,
    'new_role', 'CUSTOMER',
    'role_version', coalesce(v_profile.role_version, 1) + 1
  );
end;
$$;

comment on function public.revoke_staff_access(uuid, uuid) is
  'Scenario 13: atomically demotes a STAFF member to CUSTOMER with a last-admin guard and an audit row. An UPDATE (never a delete), so history and FKs stay intact; role_version bumps to signal the client.';

revoke all on function public.revoke_staff_access(uuid, uuid) from public;
grant execute on function public.revoke_staff_access(uuid, uuid) to authenticated;