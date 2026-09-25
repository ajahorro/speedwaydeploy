-- ============================================================================
-- Batch 1 — Scenario 9: Retroactive service price hike (logical math error)
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The admin raises "Full Detailing" from ₱100 → ₱150. Fifteen PENDING bookings
-- already selected it at ₱100. The code runs fine either way — but if any read
-- path joins the CURRENT services table (or prefers the mutable `price` column),
-- those fifteen historical bookings are silently re-priced to ₱150 and their
-- totals, receipts and balances drift. That is a catastrophic LOGICAL error, not
-- a crash.
--
-- The frozen columns already exist (final_price / price_at_booking /
-- base_price / price_snapshot / service_snapshot on booking_vehicle_services).
-- Two gaps remained:
--
--   1. NOTHING PREVENTED AN UPDATE. A later migration, an admin "edit booking
--      total_amount" write, or a bulk cron could overwrite the frozen line price
--      in place. We add a trigger that makes the booking-time price columns
--      IMMUTABLE once a row exists.
--
--   2. READERS PICKED THE WRONG COLUMN. Several components read
--      `Number(s.price || s.price_snapshot || 0)` — the mutable `price` column
--      wins over the frozen snapshot, so a catalog edit that touched `price`
--      would change a historical receipt. We publish a canonical view,
--      `booking_service_lines`, whose `effective_price` column resolves the
--      frozen value FIRST (price_at_booking → final_price → price_snapshot →
--      price) so every consumer can read one authoritative number.
-- ============================================================================

-- ── 1. Immutability guard on the frozen price columns ───────────────────────
create or replace function public.protect_booking_service_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- These columns are the immutable ledger for a booking line. They may be set
  -- on INSERT (from the booking-time snapshot) and backfilled from NULL, but an
  -- attempt to CHANGE an already-populated value is refused so a retroactive
  -- catalog price change can never rewrite history.
  if tg_op = 'UPDATE' then
    if old.price_at_booking is not null
       and new.price_at_booking is distinct from old.price_at_booking then
      raise exception 'booking_vehicle_services.price_at_booking is immutable after creation (booking-time ledger)'
        using errcode = 'check_violation';
    end if;
    if old.final_price is not null
       and new.final_price is distinct from old.final_price then
      raise exception 'booking_vehicle_services.final_price is immutable after creation (booking-time ledger)'
        using errcode = 'check_violation';
    end if;
    if old.base_price is not null
       and new.base_price is distinct from old.base_price
       and new.base_price <> 0 then
      raise exception 'booking_vehicle_services.base_price is immutable after creation (booking-time ledger)'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.protect_booking_service_price() is
  'Scenario 9: refuses any UPDATE that would rewrite a booking line''s frozen booking-time price, so a later catalog price hike cannot retroactively re-price historical bookings.';

drop trigger if exists trg_protect_booking_service_price on public.booking_vehicle_services;
create trigger trg_protect_booking_service_price
  before update on public.booking_vehicle_services
  for each row
  execute function public.protect_booking_service_price();


-- ── 2. Canonical read view (frozen price FIRST) ─────────────────────────────
-- `effective_price` is the ONE number a consumer should render. It resolves the
-- frozen booking-time value before the mutable live column.
create or replace view public.booking_service_lines as
  select
    bvs.id,
    bvs.booking_vehicle_id,
    bv.booking_id,
    bvs.service_id,
    coalesce(bvs.service_name_snapshot, bvs.service_name) as service_name,
    -- FROZEN FIRST: price_at_booking → final_price → price_snapshot → live price.
    coalesce(
      nullif(bvs.price_at_booking, 0),
      nullif(bvs.final_price, 0),
      nullif(bvs.price_snapshot, 0),
      bvs.price,
      0
    ) as effective_price,
    bvs.base_price,
    bvs.price_at_booking,
    bvs.final_price,
    bvs.price_snapshot,
    bvs.price as live_price,
    bvs.vehicle_type,
    bvs.duration_snapshot
  from public.booking_vehicle_services bvs
  join public.booking_vehicles bv on bv.id = bvs.booking_vehicle_id;

comment on view public.booking_service_lines is
  'Scenario 9: canonical per-line pricing view. effective_price resolves the FROZEN booking-time price before the mutable live price column, so receipts and totals never re-price when the catalog changes.';

grant select on public.booking_service_lines to authenticated;