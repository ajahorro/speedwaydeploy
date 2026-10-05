-- Opening hours become a database rule (master plan 4.5 propagation audit). Until now they were
-- checked only in the browser and by the validate-slot endpoint, so a request that skipped both
-- could book outside them. Minutes are honoured (08:30 opening is 08:30, not 08:00).

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
  v_is_24_7         boolean;
  v_open            time;
  v_close           time;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return 'A valid start and end time are required.';
  end if;

  select
    coalesce(booking_lead_time_minutes, 5),
    coalesce(max_advance_days, 30),
    coalesce(closed_weekdays, '{}'::integer[]),
    coalesce(is_24_7, false)
    into v_lead_minutes, v_max_advance, v_closed_weekdays, v_is_24_7
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

  -- Opening hours (minutes included). Customers must START inside them; an admin at the desk
  -- may book outside them, like the lead-time exemption. An unreadable setting never blocks.
  if not p_is_admin and not coalesce(v_is_24_7, false) then
    begin
      select opening_hour::time, closing_hour::time into v_open, v_close
        from public.business_config order by id limit 1;
    exception when others then
      v_open := null; v_close := null;
    end;
    if v_open is not null and v_close is not null
       and (v_local_start::time < v_open or v_local_start::time >= v_close) then
      return 'The shop is closed at that time. Please choose a time within opening hours.';
    end if;
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
