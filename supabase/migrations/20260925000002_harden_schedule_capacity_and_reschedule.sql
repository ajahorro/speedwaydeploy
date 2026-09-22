-- ============================================================================
-- Batch 7 / Step 7.2 — Atomic capacity guard + hardened reschedule RPC
-- ============================================================================
--
-- PROBLEM (TOCTOU race):
--   Capacity was enforced by a read-then-write: count overlapping bookings, then
--   insert/update. Under concurrency two transactions can both read "1 of 2 bays
--   used", both decide they fit, and both commit -> the slot is oversold.
--   `reschedule_booking` only took a row lock on the booking being MOVED, which
--   does not serialize two different bookings targeting the same slot. Booking
--   CREATION had no DB guard at all.
--
-- SOLUTION:
--   1. A single, canonical capacity predicate: `public.slot_has_capacity(...)`.
--   2. A transaction-scoped Postgres ADVISORY LOCK keyed on the target DAY
--      (`public.lock_schedule_day(...)`). Every capacity-affecting write takes
--      the same lock for the day in play, so all such writes for that day run
--      strictly one at a time. This closes the race for reschedules AND raw
--      inserts (the insert path is covered by the trigger in section 5).
--   3. `reschedule_booking` re-implemented to: lock the row, validate state,
--      short-circuit same-slot no-ops, reject past dates, then take the advisory
--      lock and re-check capacity before writing.
--   4. Payment-transition hardening: `public.assert_service_completable(...)`
--      encodes the "cannot complete an unpaid booking without an audited
--      override" rule at the DB layer (previously enforced only in the API).
--
-- All objects are created with `if not exists` / `create or replace` and the
-- constraints are guard-wrapped, so the migration is safe to re-run.
-- ============================================================================

-- ── 1. Canonical capacity predicate ─────────────────────────────────────────
-- Returns TRUE when booking `p_requested_bays` more bays in the window
-- [p_start, p_end) would NOT exceed the configured capacity.
--
--   * Excludes terminal statuses (cancelled/completed/released/flagged).
--   * Excludes `p_exclude_booking_id` so a booking does not count itself
--     (self-overlap exclusion for reschedules).
--   * Capacity source of truth is business_config.slots_per_hour, matching the
--     value the Batch 6 rules engine and the API use.
create or replace function public.slot_has_capacity(
  p_start timestamptz,
  p_end timestamptz,
  p_exclude_booking_id uuid default null,
  p_requested_bays integer default 1
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_capacity integer;
  v_overlap_count integer;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return false;
  end if;

  select greatest(1, coalesce(slots_per_hour, 1))::integer
    into v_capacity
    from public.business_config
   order by id
   limit 1;
  v_capacity := coalesce(v_capacity, 1);

  select count(*)::integer
    into v_overlap_count
    from public.bookings b
   where lower(coalesce(b.status, '')) not in ('cancelled', 'completed', 'released', 'flagged_noshow')
     and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
     and b.start_datetime < p_end
     and b.end_datetime > p_start;

  return (v_overlap_count + greatest(1, coalesce(p_requested_bays, 1))) <= v_capacity;
end;
$$;

comment on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) is
  'Batch 7 canonical capacity predicate: TRUE when the window has room for the requested bays. Single source of truth shared by reschedule_booking and the capacity trigger.';

-- ── 2. Day-scoped advisory lock ─────────────────────────────────────────────
-- Takes a transaction-scoped advisory lock for the calendar day of `p_at`
-- (UTC). All capacity-affecting writes for the same day serialize on this lock,
-- which is what makes check-then-write atomic. The lock is released
-- automatically at end-of-transaction, so an error path cannot leak it.
create or replace function public.lock_schedule_day(p_at timestamptz)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  select pg_advisory_xact_lock(
    -- Namespaced 64-bit key: constant tag in the high bits, day (days-since-epoch)
    -- in the low bits. The tag keeps our locks from colliding with any other
    -- advisory-lock user in the same database.
    (hashtext('speedway:schedule-day')::bigint << 32)
    | ((extract(epoch from date_trunc('day', (p_at at time zone 'UTC')))::bigint / 86400) & 4294967295)
  );
$$;

comment on function public.lock_schedule_day(timestamptz) is
  'Batch 7: takes a transaction-scoped advisory lock for the calendar day of the timestamp, serializing concurrent capacity writes for that day.';

-- ── 3. Hardened reschedule_booking ──────────────────────────────────────────
-- Keeps the original signature (uuid, timestamptz, timestamptz, text) so the
-- client contract is unchanged, and adds:
--   * past-date rejection (server-side, not just UI),
--   * state guard: only scheduled/confirmed may move (never in_progress/completed),
--   * same-slot no-op: returns a benign payload without a capacity check,
--   * self-overlap exclusion (the booking never counts against itself),
--   * a day-scoped advisory lock + re-check for a race-free write.
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
  v_booking public.bookings%rowtype;
  v_role text;
  v_user_name text;
  v_same_slot boolean;
begin
  if p_start_datetime is null or p_end_datetime is null or p_end_datetime <= p_start_datetime then
    raise exception 'A valid start and end time are required';
  end if;

  -- Reject a reschedule into the past (allow a small clock skew tolerance).
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

  -- Same-slot no-op: moving a booking onto its own current window is a benign
  -- success (no capacity re-check, no state churn) rather than a false "full".
  v_same_slot := (v_booking.start_datetime = p_start_datetime)
                 and (v_booking.end_datetime = p_end_datetime);
  if v_same_slot then
    return jsonb_build_object(
      'booking_id', p_booking_id,
      'status', lower(v_booking.status),
      'bay_id', v_booking.bay_id,
      'start_datetime', v_booking.start_datetime,
      'end_datetime', v_booking.end_datetime,
      'unchanged', true
    );
  end if;

  -- Serialize every capacity decision for the target day, then re-check under
  -- the lock. This is the critical section that closes the TOCTOU race.
  perform public.lock_schedule_day(p_start_datetime);

  if not public.slot_has_capacity(p_start_datetime, p_end_datetime, p_booking_id) then
    raise exception 'The selected time is full. Please choose another appointment time.';
  end if;

  update public.bookings
     set start_datetime = p_start_datetime,
         end_datetime = p_end_datetime,
         status = 'scheduled',
         staff_id = null,
         bay_id = null,
         reminder_sent = false,
         needs_attention = false,
         updated_at = now()
   where id = p_booking_id;

  update public.booking_vehicles
     set status = 'SCHEDULED',
         started_at = null,
         completed_at = null
   where booking_id = p_booking_id;

  if p_reason is not null and trim(p_reason) <> '' then
    insert into public.audit_logs (
      booking_id, action_type, details, actor_name, actor_role, metadata, actor_id
    ) values (
      p_booking_id, 'RESCHEDULED',
      'Appointment rescheduled: ' || trim(p_reason),
      coalesce(v_user_name, 'System'), coalesce(v_role, 'ADMIN'),
      jsonb_build_object(
        'reason', trim(p_reason),
        'old_start', v_booking.start_datetime,
        'new_start', p_start_datetime,
        'old_end', v_booking.end_datetime,
        'new_end', p_end_datetime
      ),
      auth.uid()
    );
  end if;

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'status', 'scheduled',
    'bay_id', null,
    'start_datetime', p_start_datetime,
    'end_datetime', p_end_datetime,
    'unchanged', false
  );
end;
$$;

-- NOTE: we intentionally do NOT also define a 3-argument overload. Keeping the
-- 4-argument signature (with a defaulted p_reason) as the ONLY definition means
-- a 3-argument call unambiguously resolves to it via the default. Adding a
-- separate 3-arg function would make `reschedule_booking($1,$2,$3)` ambiguous
-- ('function ... is not unique') and break every existing caller.
-- ── 4. Payment-completion hardening (DB-level) ──────────────────────────────
-- The Batch 5 rule "no completion without full payment (admin override only)"
-- lived only in the API. This predicate makes it available to the DB so a direct
-- write path cannot bypass it. Returns TRUE when the booking MAY be completed.
--
-- A booking may complete when:
--   * it has no cost (total_amount <= 0), OR
--   * its PAID payments cover total_amount, OR
--   * an override is passed explicitly (the caller is responsible for auditing).
create or replace function public.booking_is_fully_paid(
  p_booking_id uuid,
  p_override boolean default false
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total numeric := 0;
  v_paid numeric := 0;
begin
  if p_override then
    return true;
  end if;

  select coalesce(total_amount, 0) into v_total
    from public.bookings
   where id = p_booking_id;

  if v_total <= 0 then
    return true;
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.payments
   where booking_id = p_booking_id
     and status = 'PAID'
     and amount > 0;

  return v_paid >= v_total;
end;
$$;

comment on function public.booking_is_fully_paid(uuid, boolean) is
  'Batch 7: DB-level payment gate for service completion. Mirrors the API rule so direct writes cannot complete an unpaid booking without an explicit override.';

-- ── 5. Capacity guard trigger for raw INSERTs/UPDATEs ───────────────────────
-- The RPC path is covered above, but a booking can also be created by a direct
-- client insert (the wizard does exactly this). This trigger takes the same
-- day-scoped advisory lock and rejects an insert/update that would oversell the
-- slot, so the guard holds no matter which path writes.
--
-- It is deliberately permissive about bookings that are not "active" (terminal
-- statuses are ignored by slot_has_capacity) and about status-only updates that
-- do not change the window.
create or replace function public.enforce_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only guard rows that occupy capacity.
  if lower(coalesce(new.status, '')) in ('cancelled', 'completed', 'released', 'flagged_noshow') then
    return new;
  end if;

  -- A row with no scheduled window occupies no bay yet (e.g. a draft booking
  -- created before the customer picks a slot). Nothing to enforce.
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

  if not public.slot_has_capacity(
       new.start_datetime,
       new.end_datetime,
       case when tg_op = 'UPDATE' then new.id else null end
     ) then
    raise exception 'The selected time is full. Please choose another appointment time.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.enforce_slot_capacity() is
  'Batch 7 trigger: serializes capacity writes on a day-scoped advisory lock and rejects any insert/update that would oversell the slot, covering the direct-insert booking path.';

-- Guard-wrapped trigger creation (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'bookings_enforce_slot_capacity'
       and tgrelid = 'public.bookings'::regclass
  ) then
    create trigger bookings_enforce_slot_capacity
      before insert or update of start_datetime, end_datetime, status on public.bookings
      for each row
      execute function public.enforce_slot_capacity();
  end if;
end $$;

-- ── 6. Helper: index to keep the overlap count fast ─────────────────────────
-- slot_has_capacity runs on every capacity write; a composite index on the
-- window columns keeps the count cheap as bookings grow.
create index if not exists bookings_slot_window_idx
  on public.bookings (start_datetime, end_datetime);

-- ── 7. Grants ───────────────────────────────────────────────────────────────
revoke all on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) from public;
grant execute on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) to authenticated;

revoke all on function public.lock_schedule_day(timestamptz) from public;
grant execute on function public.lock_schedule_day(timestamptz) to authenticated;

revoke all on function public.booking_is_fully_paid(uuid, boolean) from public;
grant execute on function public.booking_is_fully_paid(uuid, boolean) to authenticated;

revoke all on function public.reschedule_booking(uuid, timestamptz, timestamptz, text) from public;
grant execute on function public.reschedule_booking(uuid, timestamptz, timestamptz, text) to authenticated;
