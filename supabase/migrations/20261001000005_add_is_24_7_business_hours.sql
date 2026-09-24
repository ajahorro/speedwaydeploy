-- ============================================================================
-- Add explicit "open 24 hours" support to business_config
-- ============================================================================
--
-- WHY A DEDICATED BOOLEAN (and not closing_hour = '24:00'):
--
--   The operating window was modelled as two TEXT time strings
--   (opening_hour / closing_hour, e.g. '07:00 AM' / '09:00 PM'). That model
--   cannot express a full 24-hour day:
--     * <input type="time"> rejects '24:00' (max is '23:59').
--     * The slot generator iterates [open, close), so even '00:00'..'23:59'
--       loses the final minute and a closing value of '24:00' would have to be
--       special-cased in every text parser (client, server, dashboard).
--
--   A single boolean is unambiguous, self-documenting, trivially indexable, and
--   leaves the existing text columns untouched for shops with finite hours. The
--   rules engine reads the flag and derives a 00:00..24:00 window, so no slot is
--   ever lost and every consumer (calendar, admin grid, server validator) agrees.
--
-- Defaults to FALSE so every existing row keeps its current finite-hours
-- behaviour with zero change — this migration is safe to apply on live data.
-- ============================================================================

alter table if exists public.business_config
  add column if not exists is_24_7 boolean not null default false;

-- Backfill any pre-existing NULL (defensive; the default already covers new rows).
update public.business_config
   set is_24_7 = false
 where is_24_7 is null;

comment on column public.business_config.is_24_7 is
  'When true the shop is open 24 hours: the operating window is the whole day '
  '(00:00..24:00) and opening_hour/closing_hour are ignored by the schedule '
  'rules engine. Default false (use the finite opening_hour..closing_hour window).';