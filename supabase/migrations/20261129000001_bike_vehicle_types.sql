-- Which vehicle categories count as a bike (two share one bay) is now a Business
-- Hub setting instead of a hard-coded list.
--   * business_config.bike_vehicle_types: extra category names that count as bikes.
--   * The built-in motorcycle names stay bikes whatever this holds, so an empty
--     list behaves exactly as before.
--   * vehicle_bay_weight() reads it, so booking_bay_usage / vehicle_list_bay_usage
--     / slot_has_capacity follow automatically.
-- Keep in step with getVehicleWeight() in frontend/src/config/vehicleTypes.js.

alter table public.business_config
  add column if not exists bike_vehicle_types jsonb not null default '[]'::jsonb;

create or replace function public.vehicle_bay_weight(p_vehicle_type text)
returns numeric
language sql
stable
set search_path = public
as $$
  select case
    when lower(btrim(coalesce(p_vehicle_type, ''))) in ('regular', 'bigbike', 'motorcycle', 'big_bike', 'motorbike') then 0.5
    when exists (
      select 1
        from public.business_config bc,
             jsonb_array_elements_text(
               case when jsonb_typeof(bc.bike_vehicle_types) = 'array' then bc.bike_vehicle_types else '[]'::jsonb end
             ) as t(name)
       where lower(btrim(t.name)) = lower(btrim(coalesce(p_vehicle_type, '')))
         and btrim(coalesce(p_vehicle_type, '')) <> ''
    ) then 0.5
    else 1.0
  end::numeric;
$$;

comment on function public.vehicle_bay_weight(text) is
  'Canonical bay weight: 0.5 for bike categories (built-in motorcycle names plus business_config.bike_vehicle_types; two share a bay), 1.0 otherwise. Mirrors getVehicleWeight() in frontend/src/config/vehicleTypes.js.';
