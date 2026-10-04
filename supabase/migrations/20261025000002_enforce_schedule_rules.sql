-- ============================================================================
-- Phase 3: Business Hub schedule rules are enforced by the database for every
-- new booking, with the same rules reschedules use.
--
-- Before: closed weekdays, the advance-booking window, lead time and admin
-- closures were checked only by the browser/backend before booking creation
-- (and only reschedule_booking checked them in SQL, using UTC dates, so an
-- early-morning Manila booking was judged against the previous day).
--
-- After: public.booking_schedule_violation() is the single rule set. A BEFORE
-- INSERT trigger on bookings applies it to every creation path, and
-- reschedule_booking calls the same helper. Times are evaluated in
-- public.shop_timezone().
-- ============================================================================

create or replace function public.shop_timezone()
returns text
language sql
immutable
as $$ select 'Asia/Manila'::text $$;

grant execute on function public.shop_timezone() to anon, authenticated, service_role;

-- Returns NULL when the window is allowed, otherwise the customer-facing reason.
create or replace function public.booking_schedule_violation(
  p_start timestamptz,
  p_end timestamptz,
  p_is_admin boolean default false
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lead_minutes    integer;
  v_max_advance     integer;
  v_closed_weekdays integer[];
  v_local_start     timestamp;
  v_today           date;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return 'A valid start and end time are required.';
  end if;

  select
    coalesce(booking_lead_time_minutes, 5),
    coalesce(max_advance_days, 30),
    coalesce(closed_weekdays, '{}'::integer[])
    into v_lead_minutes, v_max_advance, v_closed_weekdays
    from public.business_config
   order by id
   limit 1;

  v_lead_minutes := coalesce(v_lead_minutes, 5);
  v_max_advance := coalesce(v_max_advance, 30);
  v_closed_weekdays := coalesce(v_closed_weekdays, '{}'::integer[]);
  v_local_start := p_start at time zone public.shop_timezone();
  v_today := (now() at time zone public.shop_timezone())::date;

  if not p_is_admin and p_start < (now() - interval '5 minutes') then
    return 'The selected time is in the past. Please choose a future appointment time.';
  end if;

  -- 0 = Sunday .. 6 = Saturday, the same numbering the Business Hub stores.
  if extract(dow from v_local_start)::integer = any (v_closed_weekdays) then
    return 'The shop is closed on this day of the week. Please choose another appointment time.';
  end if;

  if v_local_start::date > v_today + v_max_advance then
    return format('Bookings can be made at most %s days in advance. Please choose an earlier date.', v_max_advance);
  end if;

  -- Lead time is customer-facing notice; an admin at the desk may book now.
  if not p_is_admin and p_start < (now() + make_interval(mins => greatest(0, v_lead_minutes))) then
    return format('Bookings need at least %s hour(s) of lead time. Please pick a later slot.',
      round((greatest(0, v_lead_minutes)::numeric / 60), 1));
  end if;

  if public.slot_window_is_blocked(p_start, p_end) then
    return 'This time has been blocked by the shop. Please choose another appointment time.';
  end if;

  return null;
end;
$$;

grant execute on function public.booking_schedule_violation(timestamptz, timestamptz, boolean) to authenticated, service_role;

-- Every new booking, whichever path created it.
create or replace function public.enforce_booking_schedule_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_violation text;
  v_is_admin boolean;
begin
  if lower(coalesce(new.status, '')) in ('cancelled', 'completed', 'released', 'flagged_noshow', 'no_show') then
    return new;
  end if;
  if new.start_datetime is null or new.end_datetime is null then
    return new;
  end if;

  -- Server-side callers (no end-user session) and admins are desk operators.
  v_is_admin := auth.uid() is null or public.is_admin();
  v_violation := public.booking_schedule_violation(new.start_datetime, new.end_datetime, v_is_admin);
  if v_violation is not null then
    raise exception '%', v_violation using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_enforce_schedule_rules on public.bookings;
create trigger bookings_enforce_schedule_rules
  before insert on public.bookings
  for each row
  execute function public.enforce_booking_schedule_rules();

-- Reschedules use the same helper (and shop-local day comparisons).
CREATE OR REPLACE FUNCTION public.reschedule_booking(p_booking_id uuid, p_start_datetime timestamp with time zone, p_end_datetime timestamp with time zone, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking         public.bookings%rowtype;
  v_role            text;
  v_user_name       text;
  v_same_slot       boolean;
  v_prior_status    text;
  v_duration        interval;
  v_staff_on_duty   integer;
  v_bays            numeric;
  v_violation       text;
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

  if coalesce(v_role, '') <> 'ADMIN' and v_booking.customer_id is distinct from auth.uid() then
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

  -- Shop schedule rules (closed weekdays, advance window, lead time for
  -- non-admins, admin closures) come from ONE helper shared with booking
  -- creation, evaluated in the shop's local time.
  v_violation := public.booking_schedule_violation(p_start_datetime, p_end_datetime, coalesce(v_role = 'ADMIN', false));
  if v_violation is not null then
    raise exception '%', v_violation;
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
           when (v_booking.start_datetime at time zone public.shop_timezone())::date
                <> (p_start_datetime at time zone public.shop_timezone())::date
             then null
           else v_booking.staff_id
         end,
         bay_id = case
           when (v_booking.start_datetime at time zone public.shop_timezone())::date
                <> (p_start_datetime at time zone public.shop_timezone())::date
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
$function$;

-- Business Hub edits reach open booking screens live.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'business_config') then
      execute 'alter publication supabase_realtime add table public.business_config';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'blocked_slots') then
      execute 'alter publication supabase_realtime add table public.blocked_slots';
    end if;
  end if;
end $$;
