-- Bay capacity is the sole scheduling limit. Staff accounts and clock-in state
-- must not reduce capacity configured through business_config.slots_per_hour.
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
  v_capacity integer;
  v_enforce boolean;
  v_used_bays numeric;
  v_requested numeric;
  v_hold_minutes integer := 30;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return false;
  end if;

  if not public.slot_within_operating_hours(p_start, p_end) then
    return false;
  end if;

  select
    greatest(1, coalesce(slots_per_hour, 1))::integer,
    coalesce(enforce_capacity, true),
    coalesce(unpaid_hold_minutes, 30)
    into v_capacity, v_enforce, v_hold_minutes
    from public.business_config
   order by id
   limit 1;

  v_capacity := coalesce(v_capacity, 1);
  v_enforce := coalesce(v_enforce, true);
  v_hold_minutes := coalesce(v_hold_minutes, 30);

  if not v_enforce then
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
       and b.created_at < now() - make_interval(mins => v_hold_minutes)
       and not exists (
         select 1 from public.payments p
          where p.booking_id = b.id
            and p.amount > 0
            and upper(coalesce(p.status, '')) in ('PAID', 'REFUND_PENDING', 'FOR_VERIFICATION')
       )
     );

  v_requested := greatest(1, coalesce(p_requested_bays, 1))::numeric;
  return (v_used_bays + v_requested) <= v_capacity;
end;
$$;

comment on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) is
  'Capacity predicate based only on weighted bay usage and business_config.slots_per_hour. Staff count is intentionally ignored.';

revoke all on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) from public;
grant execute on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer, integer) to authenticated;

-- Preserve the older four-argument signature used by booking triggers and RPCs.
create or replace function public.slot_has_capacity(
  p_start timestamptz,
  p_end timestamptz,
  p_exclude_booking_id uuid default null,
  p_requested_bays integer default 1
)
returns boolean
language sql
stable
as $$
  select public.slot_has_capacity(
    p_start,
    p_end,
    p_exclude_booking_id,
    p_requested_bays,
    1
  );
$$;

comment on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) is
  'Capacity compatibility wrapper. Delegates to the bay-only predicate; the staff argument is ignored.';

revoke all on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) from public;
grant execute on function public.slot_has_capacity(timestamptz, timestamptz, uuid, integer) to authenticated;