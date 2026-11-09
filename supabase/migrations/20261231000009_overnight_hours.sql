-- Overnight opening hours: a closing time at or before the opening time means the shop closes the next day
-- (e.g. 18:00 to 08:00). A booking may start any time the shop is open and must end by the next closing time.

alter table public.business_config drop constraint if exists business_config_hours_order;
alter table public.business_config add constraint business_config_hours_order
  check (coalesce(is_24_7, false) or nullif(btrim(opening_hour), '') is null or nullif(btrim(closing_hour), '') is null or closing_hour <> opening_hour);

create or replace function public.slot_within_operating_hours(p_start timestamptz, p_end timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_is_24_7 boolean := false;
  v_open time;
  v_close time;
  v_start timestamp;
  v_close_at timestamp;
begin
  if p_start is null or p_end is null then
    return true;
  end if;

  select coalesce(is_24_7, false),
         make_time(public.business_hour(opening_hour, 7), 0, 0),
         make_time(public.business_hour(closing_hour, 21) % 24, 0, 0)
    into v_is_24_7, v_open, v_close
    from public.business_config
   order by id
   limit 1;

  if coalesce(v_is_24_7, false) then
    return true;
  end if;

  v_start := p_start at time zone 'Asia/Singapore';
  if v_close > v_open then
    -- same-day hours: start inside them and finish by closing on the same day
    if v_start::time < v_open or v_start::time >= v_close then
      return false;
    end if;
    v_close_at := v_start::date + v_close;
  elsif v_start::time >= v_open then
    -- overnight, started in the evening: finish by closing the next day
    v_close_at := v_start::date + 1 + v_close;
  elsif v_start::time < v_close then
    -- overnight, started after midnight: finish by closing that morning
    v_close_at := v_start::date + v_close;
  else
    return false;
  end if;

  return (p_end at time zone 'Asia/Singapore') <= v_close_at;
exception when undefined_table then
  return true;
end;
$function$;

create or replace function public.booking_schedule_violation(p_start timestamptz, p_end timestamptz, p_is_admin boolean default false)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
  -- Closing at or before opening means the shop is open overnight.
  if not p_is_admin and not coalesce(v_is_24_7, false) then
    begin
      select opening_hour::time, closing_hour::time into v_open, v_close
        from public.business_config order by id limit 1;
    exception when others then
      v_open := null; v_close := null;
    end;
    if v_open is not null and v_close is not null
       and ((v_close > v_open and (v_local_start::time < v_open or v_local_start::time >= v_close))
         or (v_close <= v_open and v_local_start::time < v_open and v_local_start::time >= v_close)) then
      return 'The shop is closed at that time. Please choose a time within opening hours.';
    end if;
    if not public.slot_within_operating_hours(p_start, p_end) then
      return 'The service would run past closing time. Please choose an earlier time.';
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
$function$;

-- A service added to an open booking freezes its price like the booking's other lines (final_price,
-- price_at_booking and base_price were left empty, so the line had no booking-time price on record).
do $$
declare
  v_def text := pg_get_functiondef('public.apply_added_service(uuid, uuid, text, numeric, integer, text, jsonb, uuid, uuid, text, text, text)'::regprocedure);
  v_old text := 'insert into public.booking_vehicle_services (booking_vehicle_id, service_name, price, duration_minutes, vehicle_type, service_snapshot)
  values (p_vehicle_id, p_service_name, p_price, p_duration, p_vehicle_type,';
  v_new text := 'insert into public.booking_vehicle_services (booking_vehicle_id, service_name, price, final_price, price_at_booking, base_price, duration_minutes, vehicle_type, service_snapshot)
  values (p_vehicle_id, p_service_name, p_price, p_price, p_price, p_price, p_duration, p_vehicle_type,';
begin
  if position(v_old in v_def) = 0 then
    raise exception 'apply_added_service has changed; update this migration';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

update public.booking_vehicle_services
   set final_price = coalesce(final_price, price), price_at_booking = coalesce(price_at_booking, price)
 where coalesce(price, 0) > 0 and (final_price is null or price_at_booking is null);
