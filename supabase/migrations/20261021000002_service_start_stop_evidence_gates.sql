-- ============================================================================
-- 20261021000002 — Service start/stop gates on photo evidence
-- ============================================================================
--
-- THE RULE (stated by the shop owner)
-- -----------------------------------
--   * "Start Service" may only be pressed once the assigned staff member has
--     uploaded a BEFORE photo on their own account.
--   * "Stop/Finish Service" may only be pressed once staff have submitted AFTER
--     photo evidence.
--
-- WHY THIS IS A DATABASE RULE AND NOT A BUTTON `disabled` PROP
-- -----------------------------------------------------------
-- A disabled button is a courtesy, not a control. The same transition can be
-- reached from the admin detail page, the staff job screen, the schedule, or a
-- direct REST call. The requirement is about EVIDENCE EXISTING, which is a fact
-- the database owns — so it is enforced where the fact lives.
--
-- This reuses the existing `public.service_photos` table and its `phase`
-- discriminator ('before' = intake/pre-service, 'after' = completion/QA). No new
-- table: the migration 20260924000001 already established the model, and a
-- second evidence table would be a second source of truth.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT
-- ----------------------------------------
-- The gate depends on rows in ANOTHER table (service_photos), and it must only
-- apply on a STATUS TRANSITION (not on an unrelated edit that happens to carry
-- the same status). A CHECK constraint cannot express either. A BEFORE UPDATE
-- trigger can: it fires only when status actually changes.
--
-- RELATIONSHIP TO assert_service_completable
-- ------------------------------------------
-- `assert_service_completable(...)` (20260925000002) already hard-blocks
-- COMPLETION without an 'after' photo. This migration deliberately does NOT
-- duplicate that logic — it adds the missing START gate and wires both through
-- one shared predicate so the two rules cannot drift apart.
-- ============================================================================

-- ── 1. The shared predicate ─────────────────────────────────────────────────
-- "Does this booking have at least one photo in the given phase?"
--
-- Deliberately answers TRUE when the service_photos table is absent: this
-- migration must not brick a deployment where Batch 5 has not been applied yet.
-- A missing evidence table is a schema problem to fix, not a reason to make
-- every booking un-startable.
create or replace function public.booking_has_photo_phase(
  p_booking_id uuid,
  p_phase text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_exists boolean;
begin
  if to_regclass('public.service_photos') is null then
    return true;
  end if;

  select exists (
    select 1
      from public.service_photos sp
     where sp.booking_id = p_booking_id
       and sp.phase = p_phase
       -- An archived row is retained evidence, not live evidence.
       and coalesce(sp.archived, false) = false
  ) into v_exists;

  return coalesce(v_exists, false);
end;
$$;

comment on function public.booking_has_photo_phase(uuid, text) is
  'True when a booking has at least one non-archived service_photos row in the given phase (before/after). The single evidence predicate used by both the start and completion gates.';

-- ── 2. The start gate ───────────────────────────────────────────────────────
-- Only transitions INTO an active service state require a BEFORE photo.
-- Anything else (scheduling, cancelling, a no-show flag) is untouched.
create or replace function public.enforce_service_start_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_active boolean;
  v_is_active boolean;
begin
  v_was_active := upper(coalesce(old.status, '')) in ('IN_PROGRESS', 'ONGOING');
  v_is_active := upper(coalesce(new.status, '')) in ('IN_PROGRESS', 'ONGOING');

  -- Only a transition INTO service is gated.
  if not v_is_active or v_was_active then
    return new;
  end if;

  if not public.booking_has_photo_phase(new.id, 'before') then
    raise exception
      'SERVICE_START_BLOCKED_NO_BEFORE_PHOTO'
      using
        errcode = '23514',
        detail = 'A before-service photo must be uploaded before service can be started.',
        hint = 'Ask the assigned staff member to upload an intake photo for this booking.';
  end if;

  return new;
end;
$$;

comment on function public.enforce_service_start_evidence() is
  'BEFORE UPDATE trigger: refuses a transition into IN_PROGRESS/ONGOING unless a non-archived before photo exists for the booking.';

drop trigger if exists bookings_enforce_start_evidence on public.bookings;
create trigger bookings_enforce_start_evidence
  before update of status on public.bookings
  for each row
  execute function public.enforce_service_start_evidence();

-- ── 3. The completion gate, at the same layer ───────────────────────────────
-- `assert_service_completable` exists but is invoked by specific RPCs, so a
-- direct UPDATE to 'completed' bypassed it. Mirroring the rule as a trigger
-- closes that path and puts both gates on one code path.
create or replace function public.enforce_service_completion_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_completing boolean;
begin
  v_is_completing :=
    upper(coalesce(new.status, '')) in ('COMPLETED', 'VEHICLE_COMPLETED', 'DONE')
    and upper(coalesce(old.status, '')) not in ('COMPLETED', 'VEHICLE_COMPLETED', 'DONE');

  if not v_is_completing then
    return new;
  end if;

  if not public.booking_has_photo_phase(new.id, 'after') then
    raise exception
      'SERVICE_COMPLETE_BLOCKED_NO_AFTER_PHOTO'
      using
        errcode = '23514',
        detail = 'After-service photo evidence must be submitted before the job can be completed.',
        hint = 'Ask the assigned staff member to upload completion evidence for this booking.';
  end if;

  return new;
end;
$$;

comment on function public.enforce_service_completion_evidence() is
  'BEFORE UPDATE trigger: refuses a transition into a completed state unless a non-archived after photo exists for the booking.';

drop trigger if exists bookings_enforce_completion_evidence on public.bookings;
create trigger bookings_enforce_completion_evidence
  before update of status on public.bookings
  for each row
  execute function public.enforce_service_completion_evidence();

-- ── 4. Evidence readiness, for the UI ───────────────────────────────────────
-- One call the UI makes to decide which action buttons to offer and, when an
-- action is blocked, to say precisely WHY. The UI must never re-derive this
-- from a client-side photo query — that is how the two drift apart.
create or replace function public.booking_evidence_state(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_before boolean;
  v_after boolean;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  v_before := public.booking_has_photo_phase(p_booking_id, 'before');
  v_after := public.booking_has_photo_phase(p_booking_id, 'after');

  return jsonb_build_object(
    'found', true,
    'status', v_booking.status,
    'has_before_photo', v_before,
    'has_after_photo', v_after,
    'can_start_service', v_before,
    'can_complete_service', v_after,
    'start_blocked_reason', case when v_before then null else 'NO_BEFORE_PHOTO' end,
    'complete_blocked_reason', case when v_after then null else 'NO_AFTER_PHOTO' end,
    -- The 24h no-show window, surfaced here so the detail page needs ONE round
    -- trip for "what can I do with this booking right now?".
    'no_show_phase', public.no_show_phase(v_booking.status, v_booking.start_datetime, now()),
    'no_show_undo_deadline', public.no_show_undo_deadline(v_booking.start_datetime),
    'can_undo_no_show',
      public.no_show_phase(v_booking.status, v_booking.start_datetime, now()) = 'UNDO_WINDOW_OPEN'
  );
end;
$$;

revoke all on function public.booking_evidence_state(uuid) from public;
grant execute on function public.booking_evidence_state(uuid) to authenticated, service_role;

comment on function public.booking_evidence_state(uuid) is
  'Single call returning a booking''s photo-evidence readiness plus its no-show phase/deadline, so the UI never re-derives either rule.';