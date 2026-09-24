-- ============================================================================
-- Tier 3 / Tasks 14 & 17: Admin lifecycle protection (DB-level, defence in depth)
-- ============================================================================
--
-- POLICY (Task 14)
--   * There is, and must remain, exactly ONE default administrator. The default
--     admin's email and password may be changed, but the account can neither be
--     demoted out of ADMIN nor deleted.
--   * Non-default administrators can be managed freely (deactivated / demoted)
--     by other admins — EXCEPT when doing so would leave the system with zero
--     administrators.
--   * Every admin (default or not) has the SAME feature access. The only
--     difference is the default admin's undeletable / non-demotable status.
--
-- ENFORCEMENT (Task 17)
--   The API already checks these rules in the route handlers, but a role change
--   can also be attempted directly against Postgres (a stray console script, a
--   future endpoint, a manual dashboard action). This trigger makes the rules a
--   hard invariant of the data itself, so no caller can violate them.
--
-- All statements are guarded/idempotent and safe to re-run.
-- ============================================================================

-- -- 1. Single source of truth for the protected default admin ----------------
-- Kept in a table (not a hard-coded uuid) so the guard survives an admin
-- migration without editing SQL. Seeded with the current backend DEFAULT_ADMIN_ID.
create table if not exists public.app_singletons (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

insert into public.app_singletons (key, value)
values ('default_admin_id', '3057c70b-7eec-4445-9a1b-68118f9c6bd0')
on conflict (key) do nothing;

-- Helper: resolve the protected default admin id (nullable — guard is a no-op
-- if it is unset, which keeps fresh/dev databases usable).
create or replace function public.default_admin_id()
returns uuid
language sql stable
as $$
  select nullif(value, '')::uuid from public.app_singletons where key = 'default_admin_id';
$$;

comment on function public.default_admin_id() is
  'Tier 3 Task 14/17: the single protected default administrator. Its account may change email/password but cannot be demoted or deleted.';

-- -- 2. Lifecycle guard on public.profiles -------------------------------------
-- Fires BEFORE UPDATE (role / delete intent) and BEFORE DELETE.
create or replace function public.guard_admin_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  protected_id uuid := public.default_admin_id();
  other_admins integer;
begin
  if (tg_op = 'DELETE') then
    -- The default admin can never be deleted.
    if (protected_id is not null and old.id = protected_id) then
      raise exception 'The Default Admin account cannot be deleted.'
        using errcode = 'check_violation';
    end if;

    -- Never allow deleting the last remaining administrator.
    if upper(coalesce(old.role, '')) = 'ADMIN' then
      select count(*) into other_admins
        from public.profiles
       where id <> old.id and upper(coalesce(role, '')) = 'ADMIN';
      if other_admins = 0 then
        raise exception 'Cannot delete the last remaining administrator account.'
          using errcode = 'check_violation';
      end if;
    end if;

    return old;
  end if;

  -- tg_op = 'UPDATE'
  -- The default admin cannot be demoted out of ADMIN.
  if (protected_id is not null
      and old.id = protected_id
      and upper(coalesce(old.role, '')) = 'ADMIN'
      and upper(coalesce(new.role, '')) <> 'ADMIN') then
    raise exception 'The Default Admin account cannot be demoted.'
      using errcode = 'check_violation';
  end if;

  -- Never allow a role change that removes the last administrator.
  if (upper(coalesce(old.role, '')) = 'ADMIN'
      and upper(coalesce(new.role, '')) <> 'ADMIN') then
    select count(*) into other_admins
      from public.profiles
     where id <> old.id and upper(coalesce(role, '')) = 'ADMIN';
    if other_admins = 0 then
      raise exception 'Cannot demote the last remaining administrator account.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.guard_admin_lifecycle() is
  'Tier 3 Task 14/17: DB-level invariant enforcing a single undeletable default admin and never-zero administrators.';

drop trigger if exists trg_guard_admin_lifecycle on public.profiles;
create trigger trg_guard_admin_lifecycle
  before update or delete on public.profiles
  for each row
  execute function public.guard_admin_lifecycle();