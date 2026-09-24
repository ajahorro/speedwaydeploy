-- ============================================================================
-- Phase 1 — DB & SQL lockdown: weighted capacity as the single source of truth
--           + reschedule guard parity + version landmine cleanup.
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Three classes of defect were found in the pre-deployment audit:
--
--   RC-1 / EC-4  TWO DIFFERENT CAPACITY FORMULAS.
--                The client rules engine (frontend/src/domain/schedule/rules.js)
--                counts WEIGHTED bays (a motorcycle occupies 0.5 of a bay, so two
--                bikes share one), and additionally purges stale 'scheduled'
--                sessions older than 30 minutes from the count. The database
--                predicate `slot_has_capacity` counted plain overlapping ROWS
--                with `count(*)` and never purged anything. The result was a
--                client that offered a slot as "available" while the DB rejected
--                the very same slot — the classic slot-availability bug.
--
--   SP-2         `enforce_capacity` WAS IGNORED BY THE DATABASE.
--                The admin can switch capacity enforcement off in the Business
--                Hub. The client honoured the toggle and showed every slot as
--                free, but `slot_has_capacity` still rejected the write — so the
--                setting was a lie. The predicate now reads the toggle, so what
--                the customer sees is exactly what the database accepts.
--
--   RC-2/3/4     THE RESCHEDULE RPC SKIPPED EVERY SCHEDULING RULE AND DESTROYED
--                WORK ALREADY DONE.
--                `reschedule_booking` only checked "not in the past" and a raw
--                capacity count. It ignored lead time, the max-advance window,
--                closed weekdays and admin-blocked slots, so a booking could be
--                moved onto a closed day or a blocked slot. It also forced
--                `status = 'scheduled'` (silently demoting a CONFIRMED walk-in),
--                and unconditionally nulled `staff_id` / `bay_id` and reset
--                `booking_vehicles.started_at` / `completed_at` — destroying the
--                assignment and the in-progress history of a job already underway.
--                It now mirrors the same rules the customer calendar enforces,
--                preserves the lifecycle state and the existing allocation, and
--                only clears vehicle progress when it is genuinely safe to do so.
--
--   DB-3         AMBIGUOUS `reschedule_booking` OVERLOADS.
--                Four migrations defined this function. Two different signatures
--                exist in the wild: a 3-argument version and the current
--                4-argument version (with a defaulted `p_reason`). If a 3-arg
--                version is present, a 3-argument call becomes ambiguous and
--                Postgres fails with "function ... is not unique", breaking every
--                caller. The legacy overloads are dropped explicitly below.
--
-- Everything is `create or replace` / guarded, so the migration is safe to re-run.
-- ============================================================================


-- ── 1. Weighted bay usage: one canonical predicate ──────────────────────────
-- How many bays a single vehicle occupies. Motorcycles / big bikes share a bay
-- (0.5 each, so a pair fills one bay); every other type takes a whole bay.
-- Mirrors `getVehicleWeight` / `isBikeVehicleType` in
-- frontend/src/utils/schedulingUtils.js so the two can never drift.
create or replace function public.vehicle_bay_weight(p_vehicle_type text)
returns numeric
language sql
immutable
as $$
  select case upper(coalesce(p_vehicle_type, ''))
    when 'REGULAR'    then 0.5
    when 'BIGBIKE'    then 0.5
    when 'MOTORCYCLE' then 0.5
    when 'BIG_BIKE'   then 0.5
    when 'MOTORBIKE'  then 0.5
    else 1.0
  end::numeric;
$$;

comment on function public.vehicle_bay_weight(text) is
  'Phase 1 canonical bay weight: 0.5 for motorcycles/big bikes (two share a bay), 1.0 for everything else. Mirrors the client getVehicleWeight().';

-- Bays consumed by the vehicles attached to ONE booking, with the same
-- "cars get whole bays" rule the client uses: whole bays first, then half-bays
-- for bikes rounded UP in pairs. A booking with no vehicle rows falls back to 1
-- bay, matching `bookingBayUsage()` in rules.js for legacy records whose child
-- rows are missing.
create or replace function public.booking_bay_usage(p_booking_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total   integer := 0;
  v_bikes   integer := 0;
  v_full    integer := 0;
begin
  select count(*),
         count(*) filter (where public.vehicle_bay_weight(vehicle_type) = 0.5)
    into v_total, v_bikes
    from public.booking_vehicles
   where booking_id = p_booking_id;

  -- No child rows -> treat as a single legacy bay (never 0, which would make an
  -- existing booking invisible to capacity).
  if v_total = 0 then
    return 1;
  end if;

  v_full := v_total - v_bikes;
  return (v_full + ceil(v_bikes::numeric / 2))::numeric;
end;
$$;

comment on function public.booking_bay_usage(uuid) is
  'Phase 1: weighted bays consumed by one booking (bikes = 0.5 rounded up in pairs, others = 1). Mirrors client bookingBayUsage(); returns 1 for bookings without vehicle rows.';

-- The same rule expressed from a vehicle list, so insert-time callers (a row
-- being created, whose children may not exist yet) can weight a payload.
create or replace function public.vehicle_list_bay_usage(p_types text[])
returns numeric
language sql
immutable
as $$
  with counted as (
    select
      count(*)::integer as total,
      count(*) filter (where public.vehicle_bay_weight(t) = 0.5)::integer as bikes
    from unnest(coalesce(p_types, array[]::text[])) as t
  )
  select case
    when total = 0 then 1::numeric
    else (total - bikes + ceil(bikes::numeric / 2))::numeric
  end
  from counted;
$$;

comment on function public.vehicle_list_bay_usage(text[]) is
  'Phase 1: weighted bays for a list of vehicle types (bikes 0.5 in pairs, others 1). Used where child booking_vehicles rows do not exist yet.';

-- Add the p_staff_on_duty parameter the engine already supports on the client
-- (max_vehicles_per_staff x staff on duty). Created as a SEPARATE 5-argument
-- signature rather than replacing the 4-argument one, because the trigger and
-- older callers use the 4-argument form. The 4-argument version is re-pointed
-- to delegate here with staff_on_duty = 1 below.
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

  -- Single source of truth for the shop's configuration. `order by id` matches
  -- the backend/loader convention so a multi-row table still resolves the same
  -- row everywhere (SE-2).
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

  -- SP-2: honour the admin's master switch. With enforcement off, every in-window
  -- request is allowed, so the calendar and the database finally AGREE.
  if not v_enforce then
    return true;
  end if;

  -- Weighted, non-terminal, non-self usage of every booking overlapping the
  -- requested window. Terminal bookings release their bay; the booking being
  -- moved never counts against itself.
  select coalesce(sum(public.booking_bay_usage(b.id)), 0)
    into v_used_bays
    from public.bookings b
   where coalesce(lower(b.status), '') not in ('cancelled', 'completed', 'released', 'flagged_noshow')
     and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
     and b.start_datetime < p_end
     and b.end_datetime > p_start;

  v_requested := greatest(1, coalesce(p_requested_bays, 1))::numeric;

  -- Bay ceiling for this window.
  if (v_used_bays + v_requested) > v_capacity then
    return false;
  end if;

  -- Per-staff ceiling: concurrent vehicles may not exceed
  -- max_vehicles_per_staff x staff on duty (SP-1). Defaults to 1 staff member,
  -- which reproduces the previous behaviour exactly for callers that do not
  -- supply a headcount.
  v_staff_capacity := v_max_per_staff * greatest(1, coalesce(p_staff_on_duty, 1));
  if (v_used_bays + v_requested) > v_staff_capacity then
    return false;
  end if;

  return true;
end;
$$;

comment on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) is
  'Phase 1 canonical capacity predicate: TRUE when the window has room. Counts WEIGHTED bays (bikes 0.5), honours business_config.enforce_capacity, and applies the per-staff ceiling x staff on duty. Replaces the flat row count that disagreed with the client.';

-- Re-point the original 4-argument signature at the canonical implementation so
-- the capacity trigger and any existing caller keep working unchanged.
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
  select public.slot_has_capacity(
    p_start, p_end, p_exclude_booking_id, p_requested_bays, 1
  );
$$;

comment on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) is
  'Phase 1: 4-argument compatibility wrapper. Delegates to the 5-argument canonical predicate with staff_on_duty = 1 (preserves previous behaviour).';


-- ── 2. Blocked-slot awareness at the DB layer (RC-2) ────────────────────────
-- The client refuses a slot that overlaps a blocked_slots row (whole-day rows
-- block the day; timed rows block a window). The database never checked this,
-- so a reschedule could land on a blocked slot. `slot_window_is_blocked` gives
-- the RPC the same rule. Times are compared in the shop's local interpretation
-- of the stored DATE + TIME pair, matching how the UI renders them.
create or replace function public.slot_window_is_blocked(
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
  v_day date;
begin
  if p_start is null or p_end is null then
    return false;
  end if;

  v_day := (p_start at time zone 'UTC')::date;

  return exists (
    select 1
      from public.blocked_slots bs
     where bs.block_date = v_day
       and (
         -- A row with no start_time blocks the WHOLE day.
         bs.start_time is null
         -- Otherwise block when the requested window overlaps the blocked one.
         or (
           (v_day + coalesce(bs.start_time, '00:00'::time)) < (p_end at time zone 'UTC')
           and (v_day + coalesce(bs.end_time, '23:59:59'::time)) > (p_start at time zone 'UTC')
         )
       )
  );
exception when undefined_table then
  -- A deployment without blocked_slots simply has no blocks; never block a
  -- booking because an optional feature table is absent.
  return false;
end;
$$;

comment on function public.slot_window_is_blocked(timestamptz, timestamptz) is
  'Phase 1: TRUE when the window overlaps an admin-blocked slot (or a whole-day block) for its calendar day. Mirrors the client blocked_slots rule; fails open if blocked_slots is absent.';


-- ── 3. Hardened reschedule_booking (RC-2, RC-3, RC-4, RC-6) ─────────────────
create or replace function public.reschedule_booking(
  p_booking_id uuid,
  p_start_datetime timestamptz,
  p_end_datetime timestamptz,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking         public.bookings%rowtype;
  v_role            text;
  v_user_name       text;
  v_same_slot       boolean;
  v_prior_status    text;
  v_duration        interval;
  v_lead_minutes    integer;
  v_max_advance     integer;
  v_closed_weekdays integer[];
  v_local_start     timestamp;
  v_staff_on_duty   integer;
  v_bays            numeric;
begin
  if p_start_datetime is null or p_end_datetime is null or p_end_datetime <= p_start_datetime then
    raise exception 'A valid start and end time are required';
  end if;

  -- Reject a reschedule into the past (small clock-skew tolerance).
  if p_start_datetime < (now() - interval '5 minutes') then
    raise exception 'The selected time is in the past. Please choose a future appointment time.';
  end if;

  -- Lock the booking being moved for the duration of the transaction.
  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;
  if not found then raise exception 'Booking not found'; end if;

  select upper(role), coalesce(full_name, email) into v_role, v_user_name
    from public.profiles
   where id = auth.uid();

  if v_role <> 'ADMIN' and v_booking.customer_id <> auth.uid() then
    raise exception 'You are not authorized to reschedule this booking';
  end if;

  -- State guard: a service that has started or finished must not be moved.
  if lower(v_booking.status) not in ('scheduled', 'confirmed') then
    raise exception 'Only scheduled or confirmed bookings can be rescheduled';
  end if;

  -- Preserve the lifecycle state (RC-3). A CONFIRMED booking (e.g. a paid
  -- walk-in) stays CONFIRMED across a reschedule; only the window changes.
  v_prior_status := lower(v_booking.status);

  -- Same-slot no-op: a benign success, no capacity check and no state churn.
  v_same_slot := (v_booking.start_datetime = p_start_datetime)
                 and (v_booking.end_datetime = p_end_datetime);
  if v_same_slot then
    return jsonb_build_object(
      'booking_id', p_booking_id,
      'status', v_prior_status,
      'bay_id', v_booking.bay_id,
      'start_datetime', v_booking.start_datetime,
      'end_datetime', v_booking.end_datetime,
      'unchanged', true
    );
  end if;

  -- Load the schedule rules once. Admins rescheduling a live booking are
  -- treated as an at-the-desk action for LEAD TIME only (the customer-facing
  -- minimum notice does not apply to a desk operator), but the advance window,
  -- closed weekdays and blocked slots are enforced for EVERY caller so a
  -- booking can never be parked on a day the shop does not operate (RC-2).
  select
    coalesce(booking_lead_time_minutes, 5),
    coalesce(max_advance_days, 30),
    coalesce(closed_weekdays, '{}'::integer[])
    into v_lead_minutes, v_max_advance, v_closed_weekdays
    from public.business_config
   order by id
   limit 1;

  v_lead_minutes := coalesce(v_lead_minutes, 5);
  v_max_advance  := coalesce(v_max_advance, 30);
  v_closed_weekdays := coalesce(v_closed_weekdays, '{}'::integer[]);

  v_local_start := (p_start_datetime at time zone 'UTC');

  -- Closed weekday (JS-style 0 = Sunday .. 6 = Saturday, matching extract(dow)).
  if extract(dow from v_local_start)::integer = any (v_closed_weekdays) then
    raise exception 'The shop is closed on this day of the week. Please choose another appointment time.';
  end if;

  -- Maximum advance window.
  if v_local_start::date > ((now() at time zone 'UTC')::date + v_max_advance) then
    raise exception 'Bookings can be made at most % days in advance. Please choose an earlier date.', v_max_advance;
  end if;

  -- Minimum lead time, applied to non-admin callers only (an admin at the desk
  -- may book a slot for right now; the past-date guard above still applies).
  if v_role <> 'ADMIN'
     and p_start_datetime < (now() + make_interval(mins => greatest(0, v_lead_minutes))) then
    raise exception 'Bookings need at least % hour(s) of lead time. Please pick a later slot.',
      round((greatest(0, v_lead_minutes)::numeric / 60), 1);
  end if;

  -- Admin-blocked slots (whole-day or windowed) are never reschedulable.
  if public.slot_window_is_blocked(p_start_datetime, p_end_datetime) then
    raise exception 'This time has been blocked by the shop. Please choose another appointment time.';
  end if;

  -- Serialize every capacity decision for the target day, then re-check under
  -- the lock with the SAME weighted predicate the client uses (RC-1).
  perform public.lock_schedule_day(p_start_datetime);

  v_bays := public.booking_bay_usage(p_booking_id);
  v_staff_on_duty := 1;

  if not public.slot_has_capacity(
       p_start_datetime, p_end_datetime, p_booking_id, ceil(v_bays)::integer, v_staff_on_duty
     ) then
    raise exception 'The selected time is full. Please choose another appointment time.';
  end if;

  -- Preserve the allocation unless the window itself changed the day (RC-4).
  -- When a booking moves to a different calendar day the old bay/technician
  -- slot no longer refers to the same shift, so those assignments are cleared;
  -- a same-day move keeps them. Either way the vehicle progress history is only
  -- reset when the work has not started yet, so a rescheduled in-progress unit
  -- never loses its started_at/completed_at evidence.
  update public.bookings
     set start_datetime = p_start_datetime,
         end_datetime = p_end_datetime,
         status = v_prior_status,
         staff_id = case
           when (v_booking.start_datetime at time zone 'UTC')::date
                <> (p_start_datetime at time zone 'UTC')::date
             then null
           else v_booking.staff_id
         end,
         bay_id = case
           when (v_booking.start_datetime at time zone 'UTC')::date
                <> (p_start_datetime at time zone 'UTC')::date
             then null
           else v_booking.bay_id
         end,
         reminder_sent = false,
         needs_attention = false,
         updated_at = now()
   where id = p_booking_id;

  -- Reset vehicle scheduling markers only for units that have NOT started.
  -- A unit already in progress keeps started_at; a completed unit keeps
  -- completed_at (and its COMPLETED status) because the work was really done.
  update public.booking_vehicles
     set status = case
           when lower(coalesce(status, '')) in ('completed', 'in_progress') then status
           else 'SCHEDULED'
         end,
         started_at = case
           when lower(coalesce(status, '')) = 'in_progress' then started_at
           else null
         end,
         completed_at = case
           when lower(coalesce(status, '')) = 'completed' then completed_at
           else null
         end
   where booking_id = p_booking_id;

  -- Always audit a reschedule — the previous version skipped the audit entry
  -- entirely when no reason was supplied, even though it moved a slot and
  -- cleared or preserved the allocation (AD-1).
  insert into public.audit_logs (
    booking_id, action_type, details, actor_name, actor_role, metadata, actor_id
  ) values (
    p_booking_id, 'RESCHEDULED',
    'Appointment rescheduled' ||
      case when p_reason is not null and trim(p_reason) <> ''
           then ': ' || trim(p_reason)
           else ' (no reason supplied)' end,
    coalesce(v_user_name, 'System'), coalesce(v_role, 'ADMIN'),
    jsonb_build_object(
      'reason', nullif(trim(coalesce(p_reason, '')), ''),
      'old_start', v_booking.start_datetime,
      'new_start', p_start_datetime,
      'old_end', v_booking.end_datetime,
      'new_end', p_end_datetime,
      'prior_status', v_prior_status
    ),
    auth.uid()
  );

  v_duration := p_end_datetime - p_start_datetime;

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'status', v_prior_status,
    'bay_id', null,
    'start_datetime', p_start_datetime,
    'end_datetime', p_end_datetime,
    'duration_minutes', extract(epoch from v_duration)::integer / 60,
    'unchanged', false
  );
end;
$$;

comment on function public.reschedule_booking(uuid, timestamptz, timestamptz, text) is
  'Phase 1 hardened reschedule: enforces lead time (non-admin), max-advance window, closed weekdays and admin-blocked slots; uses the weighted capacity predicate; preserves the prior lifecycle status; keeps same-day staff/bay allocation and never destroys vehicle progress. Always audits.';


-- ── 4. Drop the ambiguous legacy overloads (DB-3) ───────────────────────────
-- Only the 4-argument signature (with a defaulted p_reason) may exist. A
-- surviving 3-argument definition makes `reschedule_booking($1,$2,$3)` ambiguous
-- ('function ... is not unique') and breaks every caller.
do $$
begin
  -- The bare 3-argument form from early migrations.
  begin
    execute 'drop function if exists public.reschedule_booking(uuid, timestamptz, timestamptz)';
  exception when undefined_function then null;
  end;

  -- A 5-argument variant must never exist either; keep the surface single.
  begin
    execute 'drop function if exists public.reschedule_booking(uuid, timestamptz, timestamptz, text, text)';
  exception when undefined_function then null;
  end;
end $$;

-- Replace the capacity trigger so it spends the WEIGHTED predicate and passes
-- the real bay count for the row being written. The insert path previously
-- assumed a single unweighted bay, so a multi-vehicle booking could oversell.
create or replace function public.enforce_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bays numeric;
begin
  -- Only guard rows that occupy capacity.
  if lower(coalesce(new.status, '')) in ('cancelled', 'completed', 'released', 'flagged_noshow') then
    return new;
  end if;

  -- A row with no scheduled window occupies no bay yet.
  if new.start_datetime is null or new.end_datetime is null then
    return new;
  end if;

  -- Skip when the time window did not change (e.g. a status-only update).
  if tg_op = 'UPDATE'
     and new.start_datetime = old.start_datetime
     and new.end_datetime = old.end_datetime then
    return new;
  end if;

  perform public.lock_schedule_day(new.start_datetime);

  -- On UPDATE the vehicle rows already exist, so weight the real fleet. On
  -- INSERT they do not exist yet: default to one bay and let the RPC, which
  -- knows the requested vehicle list, pass an explicit count.
  if tg_op = 'UPDATE' then
    v_bays := public.booking_bay_usage(new.id);
  else
    v_bays := 1;
  end if;

  if not public.slot_has_capacity(
       new.start_datetime,
       new.end_datetime,
       case when tg_op = 'UPDATE' then new.id else null end,
       greatest(1, ceil(v_bays))::integer
     ) then
    raise exception 'The selected time is full. Please choose another appointment time.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.enforce_slot_capacity() is
  'Phase 1 trigger: serializes capacity writes on a day-scoped advisory lock and rejects any insert/update that would oversell, using the weighted bay predicate and the real fleet size on update.';


-- ── 5. Grants ───────────────────────────────────────────────────────────────
revoke all on function public.vehicle_bay_weight(text) from public;
grant execute on function public.vehicle_bay_weight(text) to authenticated;

revoke all on function public.booking_bay_usage(uuid) from public;
grant execute on function public.booking_bay_usage(uuid) to authenticated;

revoke all on function public.vehicle_list_bay_usage(text[]) from public;
grant execute on function public.vehicle_list_bay_usage(text[]) to authenticated;

revoke all on function public.slot_window_is_blocked(timestamptz, timestamptz) from public;
grant execute on function public.slot_window_is_blocked(timestamptz, timestamptz) to authenticated;

revoke all on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) from public;
grant execute on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) to authenticated;

revoke all on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) from public;
grant execute on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) to authenticated;

revoke all on function public.reschedule_booking(uuid, timestamptz, timestamptz, text) from public;
grant execute on function public.reschedule_booking(uuid, timestamptz, timestamptz, text) to authenticated;


-- ── 6. Index to keep the weighted overlap sum cheap ─────────────────────────
create index if not exists bookings_slot_window_idx
  on public.bookings (start_datetime, end_datetime);

create index if not exists booking_vehicles_booking_id_idx
  on public.booking_vehicles (booking_id);

-- blocked_slots is created outside the migration chain, so guard the index:
-- a deployment without that table must not fail the whole migration.
do $$
begin
  if to_regclass('public.blocked_slots') is not null then
    execute 'create index if not exists blocked_slots_block_date_idx on public.blocked_slots (block_date)';
  end if;
end $$;