-- Schema cleanup + reproducibility hardening.
--
-- Two technical debts resolved here:
--
-- 1. Remote policy drift. The live database carries an "Allow public read
--    access" SELECT policy on public.business_config that was applied
--    out-of-band and never captured in a migration. Without it, a fresh
--    environment would build a database where the guest/anon booking portal
--    could not read promo_rules at all. This migration makes the schema 100%
--    reproducible from the migrations directory.
--
-- 2. Nullable promo_rules. The column was created nullable by
--    20260922000001 (add column ... default '[]'), so the later
--    20260923000001 migration's `add column ... not null` was skipped by its
--    own `if not exists` guard. Backfill any NULLs and enforce NOT NULL so the
--    client can never receive a non-array payload.

-- ── 1. Sync the public read policy ────────────────────────
-- Guests (anon) must be able to read active promotions for the public booking
-- portal. Idempotent: drop first so re-running converges on one definition.
drop policy if exists "Allow public read access" on public.business_config;
create policy "Allow public read access"
  on public.business_config
  for select
  to public
  using (true);

-- ── 2. Backfill + enforce NOT NULL on promo_rules ─────────────────────────
-- Coerce any NULL or non-array value to an empty JSON array before the
-- constraint is applied, so the ALTER cannot fail on dirty data.
update public.business_config
set promo_rules = '[]'::jsonb
where promo_rules is null
   or jsonb_typeof(promo_rules) <> 'array';

-- Keep the default so future inserts without an explicit value stay valid.
alter table public.business_config
  alter column promo_rules set default '[]'::jsonb;

alter table public.business_config
  alter column promo_rules set not null;
