-- ============================================================================
-- Technician capacity (owner decision).
--
-- A time slot can hold at most the LOWER of
--   * the shop's bays                      (business_config.slots_per_hour)
--   * vehicles per technician x technicians (business_config.max_vehicles_per_staff)
-- "Technicians" is the number of active STAFF accounts (minimum 1). It is the roster, not
-- who is clocked in right now, because bookings are made days ahead and a future slot must
-- not look full just because nobody has clocked in yet. This replaces the earlier rule
-- (migration 20261022000005) that bays were the only limit.
-- shop_capacity() is the one place the figure is computed; the capacity check, the backend
-- and the screens all read it.
-- ============================================================================
create or replace function public.shop_capacity()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select greatest(1, coalesce(slots_per_hour, 1))::integer as bays,
           greatest(1, coalesce(max_vehicles_per_staff, 4))::integer as per_technician
      from public.business_config
     order by id
     limit 1
  ),
  staff as (
    select greatest(1, count(*))::integer as technicians
      from public.profiles
     where upper(coalesce(role::text, '')) = 'STAFF' and coalesce(is_active, true)
  )
  select jsonb_build_object(
    'bays', coalesce(cfg.bays, 1),
    'per_technician', coalesce(cfg.per_technician, 4),
    'technicians', staff.technicians,
    'effective', least(coalesce(cfg.bays, 1), coalesce(cfg.per_technician, 4) * staff.technicians)
  )
  from staff left join cfg on true;
$$;

revoke all on function public.shop_capacity() from public, anon;
grant execute on function public.shop_capacity() to authenticated, service_role;

do $patch$
declare
  v_def text;
  v_old text := 'v_capacity := coalesce(v_capacity, 1);';
  v_new text := 'v_capacity := coalesce(v_capacity, 1);
  -- technicians limit the bays: lower of bays and vehicles-per-technician x technicians
  v_capacity := coalesce((public.shop_capacity() ->> ''effective'')::integer, v_capacity);';
begin
  select pg_get_functiondef('public.slot_has_capacity(timestamptz,timestamptz,uuid,integer,integer)'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then
    raise exception 'slot_has_capacity layout changed; patch not applied';
  end if;
  execute replace(v_def, v_old, v_new);
end
$patch$;
