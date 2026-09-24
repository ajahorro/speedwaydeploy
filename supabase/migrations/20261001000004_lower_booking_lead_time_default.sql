-- ============================================================================
-- Lower the default minimum advance notice (booking lead time) from 120 -> 5 min
-- ============================================================================
--
-- Batch 6 introduced `business_config.booking_lead_time_minutes` with a default
-- of 120 minutes (2 h). That was too aggressive for a shop that essentially runs
-- 24/7: it hid a large part of the current day from the booking calendar.
--
-- The rule is a rolling offset from "now" (`slot_start < now + lead_minutes`),
-- so a small default behaves as an intended "last few minutes" cutoff while a
-- large one silently removes whole same-day windows. 5 minutes keeps a minimal
-- guard against a slot that has already effectively passed without shrinking the
-- visible day.
--
-- This migration ONLY changes the default and rewrites rows that still carry the
-- untouched 120-minute default. Rows an admin deliberately customised to some
-- other value are left alone.
-- ============================================================================

-- ── 1. New column default for future rows ────────────────────────────────────
alter table if exists public.business_config
  alter column booking_lead_time_minutes set default 5;

-- ── 2. Backfill rows still sitting on the old 120-minute default ─────────────
-- Only touch the exact legacy default; a curated value (e.g. 30, 60, 240) is a
-- deliberate admin choice and must survive this migration.
update public.business_config
   set booking_lead_time_minutes = 5
 where booking_lead_time_minutes = 120;

-- ── 3. Refresh the column documentation to match ─────────────────────────────
comment on column public.business_config.booking_lead_time_minutes is
  'Minimum lead time (minutes) before a bookable slot. Batch 6 schedule rules. Default 5.';