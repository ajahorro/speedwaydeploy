-- ============================================================================
-- 20261021000001 — No-show lifecycle: a TWO-PHASE state machine on a 24h clock
-- ============================================================================
--
-- THE DEFECT THIS FIXES
-- ---------------------
-- `flagOverdueBookings()` (frontend/src/pages/Admin/AdminSchedule.jsx) marked a
-- booking FLAGGED_NOSHOW and stopped. Nothing in the system ever moved it on:
-- no cron, no sweep, no trigger. It was a ONE-WAY RATCHET. Three consequences,
-- all visible in production on booking #96C0C7:
--
--   1. A booking past its window stayed FLAGGED_NOSHOW forever, so the admin
--      list showed a stale no-show days later.
--   2. It was counted by the "Unassigned Fleets" container, because that query
--      excluded only `cancelled`. Flagging also NULLs staff_id, so every no-show
--      landed in Unassigned by construction.
--   3. It was DOUBLE-COUNTED: the flag set `needs_attention = true` AS WELL AS
--      `status = FLAGGED_NOSHOW`, so the same row also appeared under "Flagged
--      for Review" (needs_attention = true).
--   4. `undo-no-show` had no time check at all — the endpoint only asserted the
--      status — so the Undo button worked indefinitely.
--
-- THE MODEL (authoritative definition lives HERE, not in the UI)
-- ---------------------------------------------------------------
--   T0  = start_datetime                    (the appointment)
--   T0 + 1h  → phase 1: FLAGGED_NOSHOW      ("you have 24h to undo")
--   T0 + 24h → phase 2: CANCELLED           (undo window closed; terminal)
--
-- The 24h clock is measured from **start_datetime + INTERVAL '1 hour'** — the
-- moment service was supposed to have begun and did not. It is NOT measured from
-- when the sweep happened to notice: a booking the cron missed for six hours
-- would otherwise get a six-hour-late undo deadline, and the deadline would
-- depend on infrastructure timing rather than the appointment. Deriving it from
-- start_datetime makes the rule reproducible and testable.
--
-- SCOPE OF WHAT PHASE 1 MAY TOUCH
-- -------------------------------
-- A FLAGGED_NOSHOW booking is QUARANTINED to two places for its 24h life:
--   * the No-Show filter, and
--   * the Refund Hub, when a refund is queued (refund_status is set).
-- It must NOT appear under Unassigned, Pending Verifications, Flagged for
-- Review, Ongoing, or Pending Refund. `needs_attention` is therefore NOT set by
-- no-show flagging — that flag means "a human must look at this for another
-- reason", and a no-show already has its own container and its own deadline.
-- ============================================================================

-- ── 1. The canonical phase resolver ──────────────────────────────────────────
-- ONE function decides what phase a booking is in. The cron, the undo all call it (or read its output), so they cannot disagree about
-- whether a booking is still undoable.
--
-- Returns:
--   UNDO_WINDOW_OPEN   — flagged, still inside 24h → undo permitted
--   UNDO_WINDOW_CLOSED — flagged, past 24h       → must be cancelled
--   NOT_NO_SHOW        — not in the no-show state at all
create or replace function public.no_show_phase(
  p_status text,
  p_start_datetime timestamptz,
  p_now timestamptz default now()
)
returns text
language sql
immutable
as $$
  select case
    when upper(btrim(coalesce(p_status, ''))) not in ('FLAGGED_NOSHOW', 'NO_SHOW')
      then 'NOT_NO_SHOW'
    -- No start time recorded: we cannot compute a deadline. Treat as OPEN so a
    -- data-quality gap never silently cancels a booking — a human decides.
    when p_start_datetime is null
      then 'UNDO_WINDOW_OPEN'
    when p_now >= (p_start_datetime + interval '1 hour' + interval '24 hours')
      then 'UNDO_WINDOW_CLOSED'
    else 'UNDO_WINDOW_OPEN'
  end;
$$;

comment on function public.no_show_phase(text, timestamptz, timestamptz) is
  'Canonical no-show phase: UNDO_WINDOW_OPEN for the 24h after start_datetime+1h, then UNDO_WINDOW_CLOSED. Single source of truth for the cron, the undo endpoint and the UI.';

-- The undo deadline, as a concrete timestamp, for display ("undo closes in 6h").
create or replace function public.no_show_undo_deadline(
  p_start_datetime timestamptz
)
returns timestamptz
language sql
immutable
as $$
  select case
    when p_start_datetime is null then null
    else p_start_datetime + interval '1 hour' + interval '24 hours'
  end;
$$;

comment on function public.no_show_undo_deadline(timestamptz) is
  'The instant the no-show undo window closes: start_datetime + 1h + 24h. NULL when start_datetime is unknown.';

-- ── 2. Phase 1 — flag (unchanged semantics, minus the double-count) ──────────
-- Called by the client sweep AND by the cron below. Idempotent: the WHERE clause
-- only selects rows still in a pre-service status, so a second call is a no-op.
--
-- `needs_attention` is deliberately NOT set. See "SCOPE OF WHAT PHASE 1 MAY
-- TOUCH" above — it was the cause of the double-count.
create or replace function public.flag_no_show_bookings(
  p_grace interval default interval '1 hour',
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := p_now - p_grace;
  v_count integer := 0;
begin
  with overdue as (
    select id
      from public.bookings
     where status in ('scheduled', 'confirmed')
       and start_datetime is not null
       and start_datetime <= v_cutoff
  ), updated as (
    update public.bookings b
       set status = 'FLAGGED_NOSHOW',
           -- Never claim attention: a no-show has its own container.
           needs_attention = false,
           staff_id = null,
           bay_id = null,
           refund_status = coalesce(b.refund_status, 'QUEUED'),
           updated_at = p_now
      from overdue o
     where b.id = o.id
       -- Re-assert the status predicate inside the UPDATE so a booking that was
       -- started (or cancelled) between the SELECT and the UPDATE is left alone.
       and b.status in ('scheduled', 'confirmed')
    returning b.id
  )
  select count(*) into v_count from updated;

  if v_count > 0 then
    -- Payments on a no-show become refundable. Only rows that represent real
    -- money are touched: a FOR_VERIFICATION claim is queued too, because the
    -- customer may well have paid and the money needs a decision either way.
    update public.payments
       set status = 'REFUND_PENDING'
     where booking_id in (
             select id from public.bookings where status = 'FLAGGED_NOSHOW'
           )
       and status in ('PAID', 'FOR_VERIFICATION');
  end if;

  return v_count;
end;
$$;

comment on function public.flag_no_show_bookings(interval, timestamptz) is
  'Phase 1: flags scheduled/confirmed bookings whose start_datetime passed more than p_grace ago (default 1h) as FLAGGED_NOSHOW, clears staff/bay and queues refunds. Idempotent.';

-- ── 3. Phase 2 — close the window ────────────────────────────────────────────
-- The transition that never existed. A flagged booking past its deadline becomes
-- CANCELLED: terminal, out of the no-show container, and no longer undoable.
--
-- `fraud`/`refund_status` are RE-READ here rather than cleared: a refund that was
-- already queued must stay queued, or the customer's money is stranded with no
-- request to act on. This is why the UPDATE preserves refund_status.
create or replace function public.close_expired_no_show_windows(
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  with expired as (
    select id
      from public.bookings
     where status = 'FLAGGED_NOSHOW'
       and start_datetime is not null
       and public.no_show_phase(status, start_datetime, p_now) = 'UNDO_WINDOW_CLOSED'
  ), updated as (
    update public.bookings b
       set status = 'cancelled',
           needs_attention = false,
           staff_id = null,
           bay_id = null,
           -- Preserve a queued refund; stamp the reason so the books explain
           -- themselves without a join to an audit row.
           refund_status = coalesce(b.refund_status, 'QUEUED'),
           cancellation_reason = coalesce(
             nullif(btrim(coalesce(b.cancellation_reason, '')), ''),
             'Automatically cancelled 24 hours after being flagged as a no-show.'
           ),
           updated_at = p_now
      from expired e
     where b.id = e.id
       -- Re-assert: only a booking STILL flagged may be swept to cancelled.
       and b.status = 'FLAGGED_NOSHOW'
    returning b.id
  )
  select count(*) into v_count from updated;

  return v_count;
end;
$$;

comment on function public.close_expired_no_show_windows(timestamptz) is
  'Phase 2: cancels FLAGGED_NOSHOW bookings past their 24h undo deadline. Preserves any queued refund_status so no owed money is lost. Idempotent.';

-- ── 4. The authorized undo RPC (time-bounded, DB-enforced) ───────────────────
-- The old path was a bare UPDATE from the backend with no time check. Undo now
-- goes through ONE function that re-derives the phase itself, so a stale browser
-- tab, a replayed request, or a direct API call cannot undo a closed window.
--
-- The deadline is enforced HERE, in the database, against `now()` — not in the
-- UI and not in the Express handler. The UI hiding a button is a convenience;
-- this is the control.
create or replace function public.undo_no_show(
  p_booking_id uuid,
  p_actor_name text default 'ADMIN',
  p_pending_refund boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_phase text;
  v_has_completed_refund boolean;
begin
  perform pg_advisory_xact_lock(hashtext('speedway:noshow:' || p_booking_id::text));

  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND');
  end if;

  v_phase := public.no_show_phase(v_booking.status, v_booking.start_datetime, now());
  if v_phase = 'NOT_NO_SHOW' then
    return jsonb_build_object('success', false, 'error', 'NOT_FLAGGED_NOSHOW');
  end if;

  -- THE 24-HOUR LIMIT. This is the whole point of the change.
  if v_phase = 'UNDO_WINDOW_CLOSED' then
    return jsonb_build_object(
      'success', false,
      'error', 'UNDO_WINDOW_EXPIRED',
      'message', 'The 24-hour undo window for this no-show has closed. The booking is cancelled and cannot be reinstated.',
      'deadline', public.no_show_undo_deadline(v_booking.start_datetime)
    );
  end if;

  -- Money already returned to the customer means reinstating the booking would
  -- resurrect a debt with no payment behind it.
  select exists (
    select 1 from public.payments
     where booking_id = p_booking_id
       and (
         upper(coalesce(status, '')) in ('REFUNDED', 'REFUND_PROCESSED', 'RELEASED')
         or (upper(coalesce(method, '')) = 'SYSTEM_REFUND' and coalesce(amount, 0) < 0)
       )
  ) into v_has_completed_refund;

  if v_has_completed_refund then
    return jsonb_build_object(
      'success', false,
      'error', 'REFUND_ALREADY_PROCESSED',
      'message', 'This booking was already refunded, so it cannot be reinstated. The customer must create a new booking.'
    );
  end if;

  update public.bookings
     set status = 'scheduled',
         needs_attention = false,
         refund_status = case when p_pending_refund then 'CANCELLED' else null end,
         cancellation_reason = null,
         updated_at = now()
   where id = p_booking_id;

  -- Release the refund hold so the booking is not stuck mid-refund.
  update public.payments
     set status = case when upper(coalesce(status, '')) = 'REFUND_PENDING' then 'PAID' else status end
   where booking_id = p_booking_id
     and upper(coalesce(status, '')) = 'REFUND_PENDING';

  return jsonb_build_object(
    'success', true,
    'undone_by', coalesce(nullif(btrim(coalesce(p_actor_name, '')), ''), 'ADMIN'),
    'undo_deadline', public.no_show_undo_deadline(v_booking.start_datetime)
  );
end;
$$;

revoke all on function public.undo_no_show(uuid, text, boolean) from public;
grant execute on function public.undo_no_show(uuid, text, boolean) to authenticated, service_role;

comment on function public.undo_no_show(uuid, text, boolean) is
  'Authorized no-show undo. Refuses once the 24h window has closed (UNDO_WINDOW_EXPIRED) or once a refund has been processed. The deadline is enforced against now() in the database, not in the UI.';

-- ── 5. Cron: run BOTH phases every 5 minutes ─────────────────────────────────
-- Phase 1 must be scheduled too. The client only ran it when an admin happened
-- to open the Schedule page, which is why a booking could sit un-flagged for
-- hours and then get a deadline that depended on when someone looked.
--
-- Follows the same defensive pattern as service_photos_retention: unschedule by
-- name first (cron.schedule is not idempotent by name), and skip with a warning
-- rather than failing the migration if pg_cron is unavailable.
create or replace function public.run_no_show_lifecycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flagged integer;
  v_cancelled integer;
begin
  v_flagged := public.flag_no_show_bookings(interval '1 hour', now());
  v_cancelled := public.close_expired_no_show_windows(now());

  return jsonb_build_object(
    'flagged', v_flagged,
    'cancelled', v_cancelled,
    'ran_at', now()
  );
end;
$$;

comment on function public.run_no_show_lifecycle() is
  'Batch orchestrator invoked every 5 minutes by pg_cron: flags overdue bookings (phase 1) then cancels those whose 24h undo window has closed (phase 2).';

do $$
declare
  v_jobid bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     or exists (select 1 from pg_namespace where nspname = 'cron') then
    for v_jobid in select jobid from cron.job where jobname = 'no_show_lifecycle'
    loop
      perform cron.unschedule(v_jobid);
    end loop;

    perform cron.schedule(
      'no_show_lifecycle',
      '*/5 * * * *',
      'select public.run_no_show_lifecycle();'
    );
  else
    raise warning 'pg_cron not present: no-show lifecycle NOT scheduled; call public.run_no_show_lifecycle() from your scheduler of choice.';
  end if;
exception when others then
  raise warning 'no-show lifecycle scheduling skipped: %', sqlerrm;
end $$;

-- ── 6. Repair rows already stuck in the old broken state ─────────────────────
-- Existing FLAGGED_NOSHOW rows carry needs_attention = true from the old client
-- sweep, which is what put them in "Flagged for Review" as well as No-Show.
-- Clear that flag WITHOUT touching status: the phase-2 sweep above owns the
-- status transition, and it will pick these up on its next run.
update public.bookings
   set needs_attention = false,
       updated_at = now()
 where status = 'FLAGGED_NOSHOW'
   and needs_attention is true;

-- ── 7. Indexes for the sweep ────────────────────────────────────────────────
create index if not exists idx_bookings_noshow_start
  on public.bookings (start_datetime)
  where status = 'FLAGGED_NOSHOW';

create index if not exists idx_bookings_preservice_start
  on public.bookings (start_datetime)
  where status in ('scheduled', 'confirmed');