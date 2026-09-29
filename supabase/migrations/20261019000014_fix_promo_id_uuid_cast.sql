-- ============================================================================
-- 20261019000002_fix_promo_id_uuid_cast.sql
-- ============================================================================
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Reported symptom (booking submit, live):
--
--   POST /rest/v1/rpc/create_booking_atomic  400 (Bad Request)
--   code: '22P02'
--   message: invalid input syntax for type uuid: "promo-1790542417063"
--
-- ROOT CAUSE
-- ----------
-- The client carries TWO different kinds of promo identifier:
--
--   * a real promo row id  — a UUID (e.g. 3f6c…-…)
--   * a PACKAGE/promo rule id generated in the browser — a synthetic STRING
--     (`promo-<timestamp>`), because packages live in the client catalog and
--     have no database row.
--
-- bookingService.js sends whichever it has as `booking.applied_promo_id`, and
-- the RPC did:
--
--     nullif(v_booking ->> 'applied_promo_id', '')::uuid
--
-- For a package that is `('promo-1790542417063')::uuid`, which Postgres refuses
-- with 22P02 and ABORTS THE ENTIRE BOOKING. An invalid promo-id format must never
-- be able to take down booking submission: the promo *name* and *discount* are
-- already snapshotted separately (promo_name_snapshot / discount_amount_snapshot)
-- and are what the ledger and receipt actually display. The uuid column is a
-- convenience link for real promo rows only.
--
-- THE FIX (defence at the boundary)
-- ---------------------------------
-- Cast the value to uuid ONLY when it is already a valid UUID literal; otherwise
-- persist NULL and keep the name/discount snapshot. A malformed id degrades to
-- "no linked promo row" instead of a 400 that blocks the customer's booking.
--
-- This is applied as a targeted runtime patch on the live function body (the
-- pattern used by 20261018000003 / 20261018000011) and, like those, RAISES if
-- the anchor is not found — so it cannot silently record success without acting.
-- ============================================================================

do $patch$
declare
  v_src     text;
  v_patched text;
  v_anchor  text := 'nullif(v_booking ->> ''applied_promo_id'', '''')::uuid';
  v_repl    text := 'case when (v_booking ->> ''applied_promo_id'') ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' then (v_booking ->> ''applied_promo_id'')::uuid else null end';
begin
  select p.prosrc
    into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if v_src is null then
    raise notice 'create_booking_atomic() not found — skipping promo-id uuid-cast patch.';
    return;
  end if;

  -- Idempotent: a re-run after a previously patched body is a no-op.
  if position('case when (v_booking ->> ''applied_promo_id'')' in v_src) > 0 then
    raise notice 'create_booking_atomic() already guards applied_promo_id — nothing to do.';
    return;
  end if;

  v_patched := replace(v_src, v_anchor, v_repl);

  if v_patched = v_src then
    -- Loud, not silent: a missing anchor means the live body moved and this
    -- migration must be updated rather than recording a false success.
    raise exception 'create_booking_atomic() anchor not found for applied_promo_id uuid guard. Update the anchor in 20261019000002_fix_promo_id_uuid_cast.sql.';
  end if;

  execute format(
    'create or replace function public.create_booking_atomic(p_payload jsonb) returns jsonb language plpgsql security definer set search_path = public as %L',
    v_patched
  );

  raise notice 'create_booking_atomic() patched: applied_promo_id is cast to uuid only when it is a valid UUID, else NULL.';
end
$patch$;

-- Re-assert the grants/comment (create or replace preserves them, but stating
-- them keeps the definition self-contained and reviewable).
revoke all on function public.create_booking_atomic(jsonb) from public;
grant execute on function public.create_booking_atomic(jsonb) to authenticated;

comment on function public.create_booking_atomic(jsonb) is
  'Atomic booking creation. Writes the master booking (incl. the promo/discount snapshot and the resolved master vehicle_type), its vehicles, vehicle services, and the optional payment in a single transaction. Enum-typed columns are cast explicitly with safe fallbacks. applied_promo_id is cast to uuid ONLY when it is a valid UUID literal (a client package id like promo-<ts> would otherwise abort the whole booking with 22P02); the promo name/discount snapshots are always persisted.';

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- The function source is now readable (20261018000013_debug_function_source.sql):
--   select public.debug_function_source('create_booking_atomic');
-- and it must contain the `case when (v_booking ->> 'applied_promo_id')` guard.
-- ============================================================================