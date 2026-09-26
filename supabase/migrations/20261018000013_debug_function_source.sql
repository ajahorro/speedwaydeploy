-- ============================================================================
-- 20261018000013_debug_function_source.sql — live DDL introspection helper
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- A `supabase migration list` ledger row proves a migration was RECORDED, not
-- that its DDL actually landed. This project has migrations that patch
-- create_booking_atomic() with a runtime `replace()` on the function source:
--
--     if position('anchor text' in v_src) = 0 then ... else execute v_patched; end if;
--
-- If that anchor ever misses, the patch takes the "not found — skipping" branch,
-- the migration still COMMITS SUCCESSFULLY, and the ledger still records it as
-- applied. The database silently keeps the OLD function body. That is exactly
-- how `column "payment_status" is of type booking_payment_status but expression
-- is of type text` survived four separate "fix" migrations: migrations
-- 20261016000001..4 were applied, but the live body was never the cast version.
--
-- There is no way to read a function body through PostgREST, so the only way to
-- make "did the fix actually land?" answerable in CI is a narrow, read-only
-- introspection helper. This migration provides exactly that and nothing more.
--
-- SECURITY
-- --------
-- Function bodies are already readable by anyone with database access
-- (pg_get_functiondef / pg_proc.prosrc). This function exposes NO data and NO
-- caller-supplied SQL: it takes a bare function NAME, is restricted with a
-- hard-coded `public` schema, and returns only that function's definition.
-- EXECUTE is granted to `authenticated` (so the frontend health check can use
-- it) and service_role; PUBLIC is revoked.
-- ============================================================================

create or replace function public.debug_function_source(p_name text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select pg_get_functiondef(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = p_name
   order by p.oid
   limit 1;
$$;

comment on function public.debug_function_source(text) is
  'Read-only introspection: returns the live definition of a public function by name. Exists so CI can prove a source-patching migration actually landed instead of silently hitting its "anchor not found" branch.';

revoke all on function public.debug_function_source(text) from public;
grant execute on function public.debug_function_source(text) to authenticated;
grant execute on function public.debug_function_source(text) to service_role;