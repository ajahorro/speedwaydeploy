-- ============================================================================
-- Batch 1 Additions — Scenario 23: The Midnight Boundary Overlap (hours guard)
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The shop closes at 10:00 PM. A customer books an 8:30 PM slot for a service
-- whose dynamic duration is 4 hours (an SUV "Full Ultimate Detail"), so it would
-- finish at 12:30 AM — past closing.
--
-- The CLIENT rules engine (frontend/src/domain/schedule/rules.js) DOES enforce
-- this: `if (!cfg.is_24_7 && slotEnd > slotToDate(day, cfg.closing_hour, 0))`
-- rejects the slot. But the DATABASE never checked operating hours at all —
-- `slot_has_capacity()` only counts bay overlap. A crafted payload, a stale
-- client, or any non-UI caller could therefore create a booking that runs past
-- closing, with no error.
--
-- This migration adds a server-side operating-hours guard, invoked from the
-- capacity trigger, so the rule the customer SEES is the rule the database
-- ENFORCES — the same "client and DB must agree" principle Phase 1 applied to
-- capacity.
--
-- HANDLING THE OWNER'S LIVE CONFIG
-- --------------------------------
-- The live row has is_24_7 = true, in which case NO closing bound applies (a
-- 24/7 shop may legitimately run past midnight). The guard only bites for a
-- finite shop (is_24_7 = false).
-- ============================================================================

-- Parse a stored hour into an integer, tolerating 'HH:MM', 'HH:MM AM/PM' and
-- plain integers. Mirrors parseHour() in the frontend so the two never drift.
create or replace function public.business_hour(p_value text, p_default integer)
returns integer
language plpgsql
immutable
as $$
declare
  v text := upper(btrim(coalesce(p_value, '')));
  v_hour integer;
  v_is_pm boolean;
  v_is_am boolean;
begin
  if v = '' then return p_default; end if;

  v_is_pm := position('PM' in v) > 0;
  v_is_am := position('AM' in v) > 0;

  v := regexp_replace(v, '[^0-9:]', '', 'g');   -- strip AM/PM and spaces
  if v = '' then return p_default; end if;

  v_hour := coalesce(nullif(split_part(v, ':', 1), '')::integer, p_default);

  if v_is_pm and v_hour < 12 then v_hour := v_hour + 12; end if;
  if v_is_am and v_hour = 12 then v_hour := 0; end if;

  return greatest(0, least(24, v_hour));
exception when others then
  return p_default;
end;
$$;

comment on function public.business_hour(text, integer) is
  'Scenario 23: parses a stored opening/closing hour (''07:00'', ''09:00 PM'', 21) into an integer, matching the frontend parseHour().';


-- The guard: TRUE when a window fits inside the shop's operating hours.
create or replace function public.slot_within_operating_hours(
  p_start timestamptz,
  p_end timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_is_24_7     boolean := false;
  v_open        integer := 7;
  v_close       integer := 21;
  v_local_start timestamp;
  v_local_end   timestamp;
begin
  if p_start is null or p_end is null then
    return true;
  end if;

  select coalesce(is_24_7, false),
         public.business_hour(opening_hour, 7),
         public.business_hour(closing_hour, 21)
    into v_is_24_7, v_open, v_close
    from public.business_config
   order by id
   limit 1;

  -- A 24/7 shop has no finite window; the schedule rules engine documents that no
  -- closing bound applies in that case.
  if coalesce(v_is_24_7, false) then
    return true;
  end if;

  v_local_start := (p_start at time zone 'UTC');
  v_local_end   := (p_end at time zone 'UTC');

  -- The service must START on or after opening, and FINISH by closing on its
  -- start day. A window that crosses midnight into the next day is therefore
  -- rejected for a finite shop — the exact Scenario 23 case (8:30 PM + 4h).
  if extract(hour from v_local_start) < v_open then
    return false;
  end if;

  -- Finish by closing time on the START day.
  if v_local_end::date <> v_local_start::date then
    return false;
  end if;
  if extract(hour from v_local_end) > v_close
     or (extract(hour from v_local_end) = v_close and extract(minute from v_local_end) > 0) then
    return false;
  end if;

  return true;
exception when undefined_table then
  -- No business_config table: nothing to enforce.
  return true;
end;
$$;

comment on function public.slot_within_operating_hours(timestamptz, timestamptz) is
  'Scenario 23: TRUE when a booking window starts after opening and finishes by closing on the same day. A 24/7 shop always passes. Mirrors the client rules-engine hours bound so a crafted payload cannot book past closing.';

revoke all on function public.slot_within_operating_hours(timestamptz, timestamptz) from public;
grant execute on function public.slot_within_operating_hours(timestamptz, timestamptz) to authenticated;


-- Fold the hours guard into the capacity predicate so EVERY insert/update path
-- that already checks capacity now also checks operating hours — a single, shared
-- chokepoint.
create or replace function public.slot_has_capacity(
  p_start timestamptz,
  p_end timestamptz,
  p_exclude_booking_id uuid,
  p_requested_bays integer,
  p_staff_on_duty integer
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_capacity        integer;
  v_enforce         boolean;
  v_staff_capacity  integer;
  v_max_per_staff   integer;
  v_used_bays       numeric;
  v_requested       numeric;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return false;
  end if;

  -- Scenario 23: operating-hours bound FIRST — a window that runs past closing is
  -- never bookable, regardless of capacity.
  if not public.slot_within_operating_hours(p_start, p_end) then
    return false;
  end if;

  select
    greatest(1, coalesce(slots_per_hour, 1))::integer,
    coalesce(enforce_capacity, true),
    greatest(1, coalesce(max_vehicles_per_staff, 4))::integer
    into v_capacity, v_enforce, v_max_per_staff
    from public.business_config
   order by id
   limit 1;

  v_capacity      := coalesce(v_capacity, 1);
  v_enforce       := coalesce(v_enforce, true);
  v_max_per_staff := coalesce(v_max_per_staff, 4);

  if not v_enforce then
    return true;
  end if;

  select coalesce(sum(public.booking_bay_usage(b.id)), 0)
    into v_used_bays
    from public.bookings b
   where coalesce(lower(b.status), '') not in ('cancelled', 'completed', 'released', 'flagged_noshow')
     and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
     and b.start_datetime < p_end
     and b.end_datetime > p_start;

  v_requested := greatest(1, coalesce(p_requested_bays, 1))::numeric;

  if (v_used_bays + v_requested) > v_capacity then
    return false;
  end if;

  v_staff_capacity := v_max_per_staff * greatest(1, coalesce(p_staff_on_duty, 1));
  if (v_used_bays + v_requested) > v_staff_capacity then
    return false;
  end if;

  return true;
end;
$$;

comment on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) is
  'Batch-1: canonical capacity predicate. NOW also enforces operating hours (Scenario 23) before counting weighted bays, honouring enforce_capacity and the per-staff ceiling.';

revoke all on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) from public;
grant execute on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) to authenticated;

-- Re-point the 4-arg wrapper at the updated canonical implementation.
create or replace function public.slot_has_capacity(
  p_start timestamptz,
  p_end timestamptz,
  p_exclude_booking_id uuid default null,
  p_requested_bays integer default 1
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.slot_has_capacity(p_start, p_end, p_exclude_booking_id, p_requested_bays, 1);
$$;

revoke all on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) from public;
grant execute on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) to authenticated;