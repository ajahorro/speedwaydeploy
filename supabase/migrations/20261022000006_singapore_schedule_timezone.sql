-- Keep all schedule database decisions on the Singapore business calendar,
-- regardless of the PostgreSQL session timezone (Supabase sessions default UTC).

create or replace function public.slot_within_operating_hours(
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
  v_is_24_7 boolean := false;
  v_open integer := 7;
  v_close integer := 21;
  v_local_start timestamp;
  v_local_end timestamp;
begin
  if p_start is null or p_end is null then
    return true;
  end if;

  select coalesce(is_24_7, false),
         public.business_hour(opening_hour, 7),
         public.business_hour(closing_hour, 21)
    into v_is_24_7, v_open, v_close
    from public.business_config
   order by id
   limit 1;

  if coalesce(v_is_24_7, false) then
    return true;
  end if;

  v_local_start := p_start at time zone 'Asia/Singapore';
  v_local_end := p_end at time zone 'Asia/Singapore';

  if extract(hour from v_local_start) < v_open then
    return false;
  end if;
  if v_local_end::date <> v_local_start::date then
    return false;
  end if;
  if extract(hour from v_local_end) > v_close
     or (extract(hour from v_local_end) = v_close and extract(minute from v_local_end) > 0) then
    return false;
  end if;

  return true;
exception when undefined_table then
  return true;
end;
$$;

comment on function public.slot_within_operating_hours(timestamptz, timestamptz) is
  'Checks operating hours against Singapore local wall time, independent of the PostgreSQL session timezone.';

revoke all on function public.slot_within_operating_hours(timestamptz, timestamptz) from public;
grant execute on function public.slot_within_operating_hours(timestamptz, timestamptz) to authenticated;

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
  v_local_start timestamp;
  v_local_end timestamp;
  v_day date;
begin
  if p_start is null or p_end is null then
    return false;
  end if;

  v_local_start := p_start at time zone 'Asia/Singapore';
  v_local_end := p_end at time zone 'Asia/Singapore';
  v_day := v_local_start::date;

  return exists (
    select 1
      from public.blocked_slots bs
     where bs.block_date = v_day
       and (
         bs.start_time is null
         or (
           (v_day + coalesce(bs.start_time, '00:00'::time)) < v_local_end
           and (v_day + coalesce(bs.end_time, '23:59:59'::time)) > v_local_start
         )
       )
  );
exception when undefined_table then
  return false;
end;
$$;

comment on function public.slot_window_is_blocked(timestamptz, timestamptz) is
  'Checks blocked_slots using Singapore business-local date and time, independent of the PostgreSQL session timezone.';

revoke all on function public.slot_window_is_blocked(timestamptz, timestamptz) from public;
grant execute on function public.slot_window_is_blocked(timestamptz, timestamptz) to authenticated;

create or replace function public.lock_schedule_day(p_at timestamptz)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  select pg_advisory_xact_lock(
    (hashtext('speedway:schedule-day')::bigint << 32)
    | ((extract(epoch from date_trunc('day', p_at at time zone 'Asia/Singapore'))::bigint / 86400) & 4294967295)
  );
$$;

comment on function public.lock_schedule_day(timestamptz) is
  'Serializes capacity writes by Singapore business calendar day.';

revoke all on function public.lock_schedule_day(timestamptz) from public;
grant execute on function public.lock_schedule_day(timestamptz) to authenticated;