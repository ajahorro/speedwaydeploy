-- Keep evidence gates aligned with the app's per-vehicle lifecycle and the
-- service_photos schema's archived_at column.

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
       and sp.archived_at is null
  ) into v_exists;

  return coalesce(v_exists, false);
end;
$$;

create or replace function public.vehicle_has_photo_phase(
  p_booking_vehicle_id uuid,
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
     where sp.booking_vehicle_id = p_booking_vehicle_id
       and sp.phase = p_phase
       and sp.archived_at is null
  ) into v_exists;

  return coalesce(v_exists, false);
end;
$$;

create or replace function public.enforce_booking_vehicle_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required_phase text;
  v_error_code text;
begin
  if upper(coalesce(new.status, '')) in ('IN_PROGRESS', 'ONGOING')
     and upper(coalesce(old.status, '')) not in ('IN_PROGRESS', 'ONGOING') then
    v_required_phase := 'before';
    v_error_code := 'SERVICE_START_BLOCKED_NO_BEFORE_PHOTO';
  elsif upper(coalesce(new.status, '')) in ('COMPLETED', 'VEHICLE_COMPLETED', 'DONE')
     and upper(coalesce(old.status, '')) not in ('COMPLETED', 'VEHICLE_COMPLETED', 'DONE') then
    v_required_phase := 'after';
    v_error_code := 'SERVICE_COMPLETE_BLOCKED_NO_AFTER_PHOTO';
  else
    return new;
  end if;

  if not public.vehicle_has_photo_phase(new.id, v_required_phase) then
    raise exception '%', v_error_code
      using errcode = '23514',
        detail = case v_required_phase
          when 'before' then 'At least one before-service photo is required for this vehicle.'
          else 'At least one after-service photo is required for this vehicle.'
        end;
  end if;

  return new;
end;
$$;

drop trigger if exists booking_vehicles_enforce_evidence on public.booking_vehicles;
create trigger booking_vehicles_enforce_evidence
  before update of status on public.booking_vehicles
  for each row
  execute function public.enforce_booking_vehicle_evidence();