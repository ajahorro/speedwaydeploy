-- ============================================================================
-- Tier 3 / Audit-trail reliability: make audit_logs writes and reads reliable
-- ============================================================================
--
-- PROBLEM OBSERVED
--   Admin account actions (invite / revoke / broadcast / deactivate) succeeded,
--   but nothing appeared on the Audit Logs page. Root cause: the inserts were
--   either un-awaited or wrapped in `.catch(() => {})`. A Supabase query builder
--   is a THENABLE that RESOLVES with { data, error } — it does not reject — so a
--   failed insert was invisible. Contributing factor: depending on the ad-hoc
--   RLS on public.audit_logs, the insert could be denied outright.
--
-- FIX (defence in depth)
--   1. Guarantee the service_role can always INSERT (it bypasses RLS, but the
--      table-level GRANT must still exist).
--   2. Let authenticated admins INSERT their own audit rows (for client-side
--      events like "Report an Issue" / support requests filed from Settings).
--   3. Let authenticated ADMINS SELECT the full trail (the Audit Logs page).
--   4. Keep customers from reading other people's audit rows.
--
-- All statements are guarded/idempotent and safe to re-run.
-- ============================================================================

alter table if exists public.audit_logs enable row level security;

-- -- 1. Table-level privileges ------------------------------------------------
-- The service role bypasses RLS but still needs the INSERT privilege at the
-- table level. Authenticated users need SELECT (their row policy gates which
-- rows) and INSERT (their row policy gates what they may add).
grant select, insert on public.audit_logs to service_role;
grant select, insert on public.audit_logs to authenticated;

-- -- 2. RLS policies ----------------------------------------------------------
-- 2a. Admins can read the entire audit trail.
drop policy if exists "audit_logs_admin_select" on public.audit_logs;
create policy "audit_logs_admin_select"
  on public.audit_logs
  for select
  to authenticated
  using (public.is_admin());

-- 2b. A signed-in user can read their own audit rows (e.g. their support
--     requests). Keeps non-admins from seeing the whole trail.
drop policy if exists "audit_logs_self_select" on public.audit_logs;
create policy "audit_logs_self_select"
  on public.audit_logs
  for select
  to authenticated
  using (actor_id = auth.uid());

-- 2c. Any signed-in user may INSERT an audit row that is attributed to
--     THEMSELVES. Admins may insert rows attributed to anyone (system actions).
drop policy if exists "audit_logs_insert_self_or_admin" on public.audit_logs;
create policy "audit_logs_insert_self_or_admin"
  on public.audit_logs
  for insert
  to authenticated
  with check (
    public.is_admin()
    or actor_id is null
    or actor_id = auth.uid()
  );

-- -- 3. Make sure created_at always has a value -------------------------------
-- A NOT NULL created_at with no default would make every insert without an
-- explicit timestamp fail. Give it a default so rows are never rejected for
-- a missing timestamp (the app also stamps it explicitly, belt and braces).
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'audit_logs'
       and column_name = 'created_at'
       and column_default is null
  ) then
    alter table public.audit_logs alter column created_at set default now();
  end if;
end $$;

-- -- 4. Helpful index for the Audit Logs page (orders by created_at desc) ------
create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);
create index if not exists audit_logs_actor_id_idx
  on public.audit_logs (actor_id);