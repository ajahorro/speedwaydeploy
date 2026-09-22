-- ============================================================================
-- Batch 6 / Step 6.1 — Schedule rules engine: config columns + guards
-- ============================================================================
--
-- Adds the tunable inputs for the booking schedule restriction engine to
-- business_config. These columns are READ-ONLY inputs as far as this step is
-- concerned: the enforcement (pure rules module + server hard blocks + the
-- ValidationModal UI) lands in later steps of Batch 6.
--
--   booking_lead_time_minutes : minimum notice before a slot may be booked.
--                               Default 120 (2 h) — matches the shop's walk-in
--                               reality while still stopping accidental
--                               "book a bay in 5 minutes" submissions.
--   max_advance_days          : how far ahead the calendar may be booked.
--                               Default 30 days.
--   closed_weekdays           : array of weekdays the shop is closed, using
--                               JS-style numbering 0=Sunday .. 6=Saturday (so
--                               it lines up with `new Date().getDay()` on the
--                               client and with `extract(dow)` on the server).
--                               Default '{}' (open every weekday).
--   enforce_capacity          : master switch for the slot-capacity checks
--                               (slots_per_hour / max_vehicles_per_staff).
--                               Default true so existing shops keep behaving
--                               exactly as before.
--
-- `slots_per_hour` and `max_vehicles_per_staff` already exist on the table
-- (added in earlier batches) and are reused as the capacity inputs — no
-- duplicate columns are introduced here.
-- ============================================================================

-- ── 1. Columns (defensive: add if missing, never drop existing data) ─────────
alter table if exists public.business_config
  add column if not exists booking_lead_time_minutes integer not null default 120,
  add column if not exists max_advance_days integer not null default 30,
  add column if not exists closed_weekdays integer[] not null default '{}'::integer[],
  add column if not exists enforce_capacity boolean not null default true;

-- ── 2. Backfill any pre-existing NULLs (rows created before NOT NULL applied) ─
-- `add column ... default` only stamps rows when the column is created; if a
-- column already existed from a partial run it may hold NULL. Normalise anyway.
update public.business_config
   set booking_lead_time_minutes = 120
 where booking_lead_time_minutes is null;

update public.business_config
   set max_advance_days = 30
 where max_advance_days is null;

update public.business_config
   set closed_weekdays = '{}'::integer[]
 where closed_weekdays is null;

update public.business_config
   set enforce_capacity = true
 where enforce_capacity is null;

-- ── 3. Sanity constraints (guarded so the migration is re-runnable) ──────────
-- Bounds keep a fat-fingered admin from locking the calendar out entirely
-- (e.g. a 5-year lead time or a 999-day advance window).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'business_config_lead_time_bounds'
  ) then
    alter table public.business_config
      add constraint business_config_lead_time_bounds
      check (booking_lead_time_minutes between 0 and 43200); -- 0 min .. 30 days
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'business_config_advance_days_bounds'
  ) then
    alter table public.business_config
      add constraint business_config_advance_days_bounds
      check (max_advance_days between 1 and 365);
  end if;

  -- Every element must be a valid weekday number 0..6 (Sun..Sat).
  if not exists (
    select 1 from pg_constraint where conname = 'business_config_closed_weekdays_valid'
  ) then
    alter table public.business_config
      add constraint business_config_closed_weekdays_valid
      check (
        closed_weekdays <@ array[0,1,2,3,4,5,6]::integer[]
      );
  end if;
end $$;

-- ── 4. Documentation ────────────────────────────────────────────────────────
comment on column public.business_config.booking_lead_time_minutes is
  'Minimum lead time (minutes) before a bookable slot. Batch 6 schedule rules. Default 120.';
comment on column public.business_config.max_advance_days is
  'Maximum number of days ahead a booking may be scheduled. Batch 6 schedule rules. Default 30.';
comment on column public.business_config.closed_weekdays is
  'Weekdays the shop is closed as JS-style day numbers 0=Sun..6=Sat. Empty array = open every day. Default {}.';
comment on column public.business_config.enforce_capacity is
  'Master switch for slot capacity enforcement (slots_per_hour / max_vehicles_per_staff). Default true.';
