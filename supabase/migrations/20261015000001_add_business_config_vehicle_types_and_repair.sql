-- Add vehicle_types to business_config.
--
-- The admin Service Catalog writes business_config.vehicle_types (the list of
-- vehicle categories/bays the shop services), but no prior migration ever
-- created the column. That omission caused every catalog save to fail with
-- PGRST204 ("Could not find the 'vehicle_types' column ... in the schema cache").
--
-- This migration is idempotent and safe to re-run. It also defensively
-- re-asserts the other optional business_config columns the frontend writes
-- (custom_services, is_24_7, faqs) so a partially-migrated database is repaired
-- in one step.

alter table if exists public.business_config
  add column if not exists vehicle_types jsonb default '[]'::jsonb;

alter table if exists public.business_config
  add column if not exists custom_services jsonb default '[]'::jsonb;

alter table if exists public.business_config
  add column if not exists is_24_7 boolean default false;

alter table if exists public.business_config
  add column if not exists faqs jsonb default '[]'::jsonb;

-- Backfill any existing rows (older rows may have NULL after a partial add).
update public.business_config set vehicle_types = '[]'::jsonb where vehicle_types is null;
update public.business_config set custom_services = '[]'::jsonb where custom_services is null;
update public.business_config set is_24_7 = false where is_24_7 is null;
update public.business_config set faqs = '[]'::jsonb where faqs is null;

-- Ask PostgREST to refresh its schema cache so the new column is visible
-- immediately without waiting for the next reload.
notify pgrst, 'reload schema';