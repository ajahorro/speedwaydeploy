-- ============================================================================
-- Adding a service while the work is under way.
--
-- A started booking already holds its bay for the time it has used. Adding a service only makes it run longer, so the
-- only question is whether the EXTRA time (from the old end to the new end) fits: another booking in that time may need
-- the bay. The old guard re-checked the whole window from the start, including the part already used and the
-- operating hours of the start, which refused every extension of a job that had begun.
-- For a started booking whose start did not change and whose end moved later:
--   * only the extra time is checked, against the bays other bookings use at that time;
--   * the shop's closing time is not re-checked here (the customer path checks it in the server, the administrator
--     confirms an after-hours extension explicitly);
--   * if the bays are taken, the message says another booking needs the bay.
-- Everything else (new bookings, moving a start, extending a booking that has not started) is checked as before.
-- ============================================================================
create or replace function public.slot_has_capacity_ignoring_hours(
  p_start timestamptz, p_end timestamptz, p_exclude_booking_id uuid, p_requested_bays integer
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_capacity integer;
  v_enforce boolean;
  v_used_bays numeric;
  v_hold_minutes integer := 30;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return true;
  end if;
  select greatest(1, coalesce(slots_per_hour, 1))::integer, coalesce(enforce_capacity, true), coalesce(unpaid_hold_minutes, 30)
    into v_capacity, v_enforce, v_hold_minutes
    from public.business_config order by id limit 1;
  v_capacity := coalesce((public.shop_capacity() ->> 'effective')::integer, coalesce(v_capacity, 1));
  if not coalesce(v_enforce, true) then
    return true;
  end if;
  select coalesce(sum(public.booking_bay_usage(b.id)), 0)
    into v_used_bays
    from public.bookings b
   where coalesce(lower(b.status), '') not in ('cancelled', 'completed', 'released', 'flagged_noshow')
     and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
     and b.start_datetime < p_end
     and b.end_datetime > p_start
     and not (
       lower(coalesce(b.status, '')) in ('scheduled', 'pending', 'pending_confirmation')
       and b.created_at < now() - make_interval(mins => coalesce(v_hold_minutes, 30))
       and not exists (
         select 1 from public.payments p
          where p.booking_id = b.id and p.amount > 0
            and upper(coalesce(p.status, '')) in ('PAID', 'REFUND_PENDING', 'FOR_VERIFICATION')
       )
     );
  return (v_used_bays + greatest(1, coalesce(p_requested_bays, 1))) <= v_capacity;
end;
$fn$;
revoke all on function public.slot_has_capacity_ignoring_hours(timestamptz, timestamptz, uuid, integer) from public, anon, authenticated;

create or replace function public.enforce_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bays numeric;
begin
  if lower(coalesce(new.status, '')) in ('cancelled', 'completed', 'released', 'flagged_noshow') then
    return new;
  end if;
  if new.start_datetime is null or new.end_datetime is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.start_datetime = old.start_datetime
     and new.end_datetime = old.end_datetime then
    return new;
  end if;

  perform public.lock_schedule_day(new.start_datetime);

  if tg_op = 'UPDATE' then
    v_bays := public.booking_bay_usage(new.id);
  else
    v_bays := 1;
  end if;

  -- a started booking that only runs longer: check the extra time only
  if tg_op = 'UPDATE'
     and new.start_datetime = old.start_datetime
     and new.end_datetime > old.end_datetime
     and old.start_datetime <= now() then
    if not public.slot_has_capacity_ignoring_hours(old.end_datetime, new.end_datetime, new.id, greatest(1, ceil(v_bays))::integer) then
      raise exception 'Another booking needs the bay during the extra time, so this service cannot be added to the running job.'
        using errcode = 'check_violation';
    end if;
    return new;
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
$fn$;
