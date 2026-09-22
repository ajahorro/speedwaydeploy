-- ============================================================================
-- Admin Account Long-Term Fix / Tier 2.8 — FAQ feature (business_config.faqs)
-- ============================================================================
--
-- The landing page previously hard-coded a list of FAQ questions with Lorem
-- ipsum answers. This adds a first-class, admin-editable `faqs` JSONB column so
-- the Business Hub can add / edit / delete / reorder FAQ entries and the public
-- landing page can render them.
--
-- Storage shape (array, order = display order):
--   [
--     { "id": "faq_...", "question": "...", "answer": "...", "order": 0 }
--   ]
--
-- Mirrors the existing `custom_services` / `promo_rules` jsonb-array pattern
-- (migration 20260922000001 + 20260923000003): idempotent, self-backfilling,
-- and re-runnable.
-- ============================================================================

-- ── 1. Column (defensive: add if missing, never drop existing data) ──────────
alter table if exists public.business_config
  add column if not exists faqs jsonb not null default '[]'::jsonb;

-- ── 2. Backfill / coerce any NULL or non-array value to an empty array ───────
-- Guards the CHECK constraint below against dirty pre-existing data.
update public.business_config
   set faqs = '[]'::jsonb
 where faqs is null
    or jsonb_typeof(faqs) <> 'array';

-- ── 3. Integrity (guarded so the migration stays re-runnable) ────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'business_config_faqs_is_array'
  ) then
    alter table public.business_config
      add constraint business_config_faqs_is_array
      check (jsonb_typeof(faqs) = 'array');
  end if;
end $$;

-- ── 4. Documentation ────────────────────────────────────────────────────────
comment on column public.business_config.faqs is
  'Admin-editable FAQ entries rendered on the public landing page. Array of { id, question, answer, order }. Default [] (the landing falls back to its built-in starter questions when empty).';
