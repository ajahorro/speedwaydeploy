-- ============================================================================
-- Batch 1 Additions — Scenario 21: Unpaid Cart Abandonment & Auto-Release
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- VERIFIED DEFECTS:
--
--   1. NO PRE-START RELEASE. A booking created but abandoned at the payment
--      step held its bay from creation all the way to `start + 60 min` (the
--      no-show audit). A walk-in arriving BEFORE the abandoned start time — e.g.
--      at 1:45 PM for a 2:00 PM slot — was hard-blocked by a booking that will
--      never be paid for.
--
--   2. CLIENT/DB DISAGREEMENT. `filterActiveBookings()` (client) purged stale
--      `scheduled` bookings after 30 minutes, so the calendar SHOWED the slot as
--      free; but `slot_has_capacity()` (DB) kept counting the row until the
--      60-minute no-show flag. Between those windows a customer saw an "open"
--      slot that the database rejected — the classic client/DB drift Phase 1 was
--      built to eliminate.
--
-- THE FIX
-- -------
--   * `business_config.unpaid_hold_minutes` (default 30) — how long an UNPAID
--     booking may hold a slot before it is auto-released.
--   * `release_expired_unpaid_holds()` — cancels non-terminal, unpaid bookings
--     past the hold window, freeing their bays. Idempotent and status-scoped.
--   * `slot_has_capacity()` now IGNORES an expired unpaid hold when summing used
--     bays, so the DB agrees with what the client shows even before the sweep
--     runs. (Belt AND braces: the predicate stops counting it; the sweep changes
--     its status so the UI reflects reality.)
-- ============================================================================

-- ── 0. Config ───────────────────────────────────────────────────────────────
alter table public.business_config
  add column if not exists unpaid_hold_minutes integer not null default 30;

comment on column public.business_config.unpaid_hold_minutes is
  'Scenario 21: how long an unpaid booking may hold a slot before auto-release. Aligns the DB capacity predicate with the client stale-session purge.';


-- ── 1. Sweep: release expired unpaid holds ──────────────────────────────────
create or replace function public.release_expired_unpaid_holds()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold_minutes integer := 30;
  v_now          timestamptz := now();
  v_released     uuid[] := '{}';
  v_booking      record;
  v_is_unpaid    boolean;
begin
  select coalesce(unpaid_hold_minutes, 30) into v_hold_minutes
    from public.business_config order by id limit 1;

  for v_booking in
    select b.id, b.created_at, b.start_datetime
      from public.bookings b
     where lower(coalesce(b.status, '')) in ('scheduled', 'pending', 'pending_confirmation')
       -- The hold window is measured from creation, and only applies BEFORE the
       -- service would have started (an in-progress/day-of booking is handled by
       -- the no-show audit, not this sweep).
       and b.start_datetime is not null
       and b.start_datetime > v_now
       and b.created_at < v_now - make_interval(mins => v_hold_minutes)
     for update
  loop
    -- Unpaid = no settled or pending-verification money on the booking.
    select not exists (
      select 1 from public.payments p
       where p.booking_id = v_booking.id
         and p.amount > 0
         and upper(coalesce(p.status, '')) in ('PAID', 'REFUND_PENDING', 'FOR_VERIFICATION')
    ) into v_is_unpaid;

    if not v_is_unpaid then
      continue;
    end if;

    v_released := v_released || v_booking.id;

    update public.bookings
       set status = 'cancelled',
           cancellation_reason = 'Auto-released: unpaid beyond the hold window',
           cancellation_type = 'AUTO_RELEASE_UNPAID',
           updated_at = v_now
     where id = v_booking.id;

    update public.booking_vehicles
       set status = 'cancelled'
     where booking_id = v_booking.id;

    insert into public.audit_logs (booking_id, action_type, details, actor_name, actor_role, metadata)
    values (
      v_booking.id, 'AUTO_RELEASE_UNPAID',
      format('Unpaid booking auto-released after %s minutes; slot freed.', v_hold_minutes),
      'SYSTEM', 'SYSTEM',
      jsonb_build_object('hold_minutes', v_hold_minutes, 'created_at', v_booking.created_at)
    );
  end loop;

  return jsonb_build_object('released_count', coalesce(array_length(v_released, 1), 0), 'released', to_jsonb(v_released));
end;
$$;

comment on function public.release_expired_unpaid_holds() is
  'Scenario 21: cancels non-terminal, unpaid bookings older than unpaid_hold_minutes (and still in the future), freeing their bays. Run by the backend sweep; idempotent.';

revoke all on function public.release_expired_unpaid_holds() from public;
grant execute on function public.release_expired_unpaid_holds() to service_role;


-- ── 2. Count expired holds as FREE in the capacity predicate ────────────────
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
  v_hold_minutes    integer := 30;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return false;
  end if;

  -- Scenario 23: operating-hours bound FIRST.
  if not public.slot_within_operating_hours(p_start, p_end) then
    return false;
  end if;

  select
    greatest(1, coalesce(slots_per_hour, 1))::integer,
    coalesce(enforce_capacity, true),
    greatest(1, coalesce(max_vehicles_per_staff, 4))::integer,
    coalesce(unpaid_hold_minutes, 30)
    into v_capacity, v_enforce, v_max_per_staff, v_hold_minutes
    from public.business_config
   order by id
   limit 1;

  v_capacity      := coalesce(v_capacity, 1);
  v_enforce       := coalesce(v_enforce, true);
  v_max_per_staff := coalesce(v_max_per_staff, 4);
  v_hold_minutes  := coalesce(v_hold_minutes, 30);

  if not v_enforce then
    return true;
  end if;

  -- Scenario 21: an EXPIRED UNPAID HOLD does not occupy a bay. A scheduled row
  -- created more than unpaid_hold_minutes ago with no settled/verifying payment
  -- is treated as free even before the sweep changes its status — so the DB and
  -- the client calendar AGREE.
  select coalesce(sum(public.booking_bay_usage(b.id)), 0)
    into v_used_bays
    from public.bookings b
   where coalesce(lower(b.status), '') not in ('cancelled', 'completed', 'released', 'flagged_noshow')
     and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
     and b.start_datetime < p_end
     and b.end_datetime > p_start
     and not (
       lower(coalesce(b.status, '')) in ('scheduled', 'pending', 'pending_confirmation')
       and b.created_at < now() - make_interval(mins => v_hold_minutes)
       and not exists (
         select 1 from public.payments p
          where p.booking_id = b.id
            and p.amount > 0
            and upper(coalesce(p.status, '')) in ('PAID', 'REFUND_PENDING', 'FOR_VERIFICATION')
       )
     );

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
  'Batch-1: canonical capacity predicate. Enforces operating hours (SC-23) AND ignores expired unpaid holds (SC-21) so the DB agrees with the client calendar, then counts weighted bays with the per-staff ceiling.';

revoke all on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) from public;
grant execute on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) to authenticated;


-- ── 3. Align the 30-min client purge with the server hold window ────────────
-- The client `filterActiveBookings` uses SHOP_CONFIG.STALE_SESSION_PURGE_MINUTES
-- (30). This snapshot view lets the UI read the SAME number the DB uses, so the
-- two can never drift again.
create or replace view public.schedule_capacity_config as
  select
    greatest(1, coalesce(slots_per_hour, 1))          as slots_per_hour,
    coalesce(enforce_capacity, true)                   as enforce_capacity,
    greatest(1, coalesce(max_vehicles_per_staff, 4))   as max_vehicles_per_staff,
    coalesce(unpaid_hold_minutes, 30)                  as unpaid_hold_minutes,
    coalesce(booking_lead_time_minutes, 5)             as booking_lead_time_minutes,
    coalesce(max_advance_days, 30)                     as max_advance_days,
    coalesce(closed_weekdays, '{}'::integer[])         as closed_weekdays,
    coalesce(is_24_7, false)                           as is_24_7,
    opening_hour, closing_hour
  from public.business_config
  order by id
  limit 1;

comment on view public.schedule_capacity_config is
  'Scenario 21: single source of truth for capacity/schedule config, incl. unpaid_hold_minutes, so the client stale-purge window and the DB predicate can never disagree.';

grant select on public.schedule_capacity_config to authenticated;