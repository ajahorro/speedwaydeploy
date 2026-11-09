-- Business Hub guards (found by a 45-scenario stress test).
-- 1. The booking price check let a promotion or promo code discount services it does not cover: an SUV-only
--    promo was accepted on a sedan, and a code for "Basic Carwash" took 50% off a Detailing Package. The check
--    now applies each promotion and code only to the vehicles and services it covers, matching the booking page.
-- 2. The settings the Business Hub already refuses are refused by the database too: at least 1 bay, 1 to 20
--    vehicles per technician, and closing after opening unless the shop is open 24 hours.

alter table public.business_config drop constraint if exists business_config_slots_min;
alter table public.business_config add constraint business_config_slots_min check (slots_per_hour >= 1);
alter table public.business_config drop constraint if exists business_config_per_staff_bounds;
alter table public.business_config add constraint business_config_per_staff_bounds check (max_vehicles_per_staff between 1 and 20);
alter table public.business_config drop constraint if exists business_config_hours_order;
alter table public.business_config add constraint business_config_hours_order
  check (coalesce(is_24_7, false) or nullif(btrim(opening_hour), '') is null or nullif(btrim(closing_hour), '') is null or closing_hour > opening_hour);

-- Does a promotion cover this service on this vehicle? Same rules as the booking page (servicesCatalog.js):
-- a per-vehicle list decides when it names the vehicle; otherwise the vehicle and service lists, by partial name.
create or replace function public.promo_rule_covers(p_rule jsonb, p_vehicle text, p_service text)
returns boolean
language sql
immutable
set search_path = public
as $$
  with t as (select lower(public.catalog_vehicle_key(p_vehicle)) v, lower(btrim(coalesce(p_service, ''))) s),
  m as (
    select e.value as list
      from t, jsonb_each(case when jsonb_typeof(p_rule -> 'vehicleServiceMatrix') = 'object' then p_rule -> 'vehicleServiceMatrix' else '{}' end) e
     where lower(public.catalog_vehicle_key(e.key)) = t.v and jsonb_typeof(e.value) = 'array' and jsonb_array_length(e.value) > 0
     limit 1
  ),
  names as (select coalesce(case when jsonb_typeof(p_rule -> 'serviceMatches') = 'array' then p_rule -> 'serviceMatches' end,
                            case when jsonb_typeof(p_rule -> 'serviceNames') = 'array' then p_rule -> 'serviceNames' end, '[]') list)
  select case
    when exists (select 1 from m) then
      exists (select 1 from m, t, jsonb_array_elements_text(m.list) x
               where lower(btrim(x)) = t.s or t.s like '%' || lower(btrim(x)) || '%' or lower(btrim(x)) like '%' || t.s || '%')
    else
      (jsonb_typeof(p_rule -> 'vehicleTypes') is distinct from 'array' or jsonb_array_length(p_rule -> 'vehicleTypes') = 0
        or exists (select 1 from t, jsonb_array_elements_text(p_rule -> 'vehicleTypes') x where lower(public.catalog_vehicle_key(x)) = t.v))
      and ((select jsonb_array_length(list) from names) = 0
        or exists (select 1 from t, names, jsonb_array_elements_text(names.list) x
                   where btrim(x) = '' or t.s like '%' || lower(btrim(x)) || '%' or lower(btrim(x)) like '%' || t.s || '%'))
  end
$$;

create or replace function public.assert_booking_pricing(p_payload jsonb)
returns void
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_total numeric := nullif(p_payload #>> '{booking,total_amount}', '')::numeric;
  v_code text := nullif(btrim(coalesce(p_payload #>> '{booking,promo_code}', '')), '');
  v_rules jsonb := '[]';
  v_live jsonb := '[]';
  v_rule jsonb;
  v_value numeric;
  v_from timestamptz;
  v_until timestamptz;
  v_vehicle jsonb;
  v_vtype text;
  v_line jsonb;
  v_name text;
  v_price numeric;
  v_factor numeric;
  v_fixed numeric;
  v_line_floor numeric;
  v_std_floor numeric;
  v_pkg_min numeric;
  v_veh_code numeric;
  v_floor numeric := 0;
  v_standalone numeric := 0;
  v_code_eligible numeric := 0;
  v_code_type text;
  v_code_value numeric;
  v_code_types text[];
  v_code_names text[];
begin
  if auth.uid() is null then return; end if;
  if v_total is null or v_total < 0 then
    raise exception 'A valid booking total is required.' using errcode = '23514';
  end if;

  -- live promotions (a day of grace either side, as before)
  select coalesce(promo_rules, '[]'::jsonb) into v_rules from public.business_config order by id limit 1;
  for v_rule in select * from jsonb_array_elements(case when jsonb_typeof(coalesce(v_rules, '[]'::jsonb)) = 'array' then v_rules else '[]'::jsonb end)
  loop
    continue when coalesce((v_rule ->> 'active')::boolean, true) = false
               or coalesce((v_rule ->> 'is_active')::boolean, true) = false
               or nullif(v_rule ->> 'deleted_at', '') is not null
               or nullif(v_rule ->> 'archived_at', '') is not null;
    begin v_from := nullif(coalesce(v_rule ->> 'validFrom', v_rule ->> 'valid_from'), '')::timestamptz; exception when others then v_from := null; end;
    begin
      v_until := case when coalesce(v_rule ->> 'neverExpires', v_rule ->> 'never_expires', '') = 'true'
                        or coalesce(v_rule ->> 'validUntil', v_rule ->> 'valid_until', '') = 'never'
                      then null
                      else nullif(coalesce(v_rule ->> 'validUntil', v_rule ->> 'valid_until'), '')::timestamptz end;
    exception when others then v_until := null; end;
    continue when (v_from is not null and v_from > now() + interval '1 day')
               or (v_until is not null and v_until < now() - interval '1 day');
    begin v_value := (v_rule ->> 'value')::numeric; exception when others then v_value := null; end;
    continue when v_value is null or v_value < 0;
    v_live := v_live || jsonb_build_array(v_rule || jsonb_build_object('value', v_value));
  end loop;

  if v_code is not null then
    select discount_type, discount_value, coalesce(vehicle_types, '{}'), coalesce(service_names, '{}')
      into v_code_type, v_code_value, v_code_types, v_code_names
      from public.promo_codes where lower(btrim(code)) = lower(v_code) limit 1;
  end if;

  for v_vehicle in select * from jsonb_array_elements(coalesce(p_payload -> 'vehicles', '[]'::jsonb))
  loop
    v_vtype := v_vehicle #>> '{vehicle,vehicle_type}';
    v_std_floor := 0;
    v_veh_code := 0;
    v_pkg_min := null;
    for v_line in select * from jsonb_array_elements(coalesce(v_vehicle -> 'services', '[]'::jsonb))
    loop
      v_name := v_line ->> 'service_name';
      v_price := public.catalog_service_price(v_name, v_vtype);
      if v_price is null then
        raise exception 'The service "%" is not available for this vehicle type. Refresh and choose again.', coalesce(v_name, '?')
          using errcode = '23514';
      end if;
      v_standalone := v_standalone + v_price;
      v_factor := 1;
      v_fixed := 0;
      for v_rule in select * from jsonb_array_elements(v_live)
      loop
        continue when v_rule ->> 'mode' = 'package' or v_rule ->> 'type' = 'fixed_package';
        continue when not public.promo_rule_covers(v_rule, v_vtype, v_name);
        if v_rule ->> 'type' = 'percentage' then
          v_factor := v_factor * (1 - least((v_rule ->> 'value')::numeric, 100) / 100);
        elsif v_rule ->> 'type' = 'fixed' then
          v_fixed := v_fixed + (v_rule ->> 'value')::numeric;
        end if;
      end loop;
      v_line_floor := greatest(0, v_price * v_factor - v_fixed);
      v_std_floor := v_std_floor + v_line_floor;
      if v_code_type is not null
         and (cardinality(v_code_types) = 0 or exists (select 1 from unnest(v_code_types) x where lower(public.catalog_vehicle_key(x)) = lower(public.catalog_vehicle_key(v_vtype))))
         and (cardinality(v_code_names) = 0 or exists (select 1 from unnest(v_code_names) x where lower(btrim(x)) = lower(btrim(v_name)))) then
        v_veh_code := v_veh_code + v_line_floor;
      end if;
    end loop;
    -- a package scoping this vehicle may price it lower (a package never takes a code)
    for v_rule in select * from jsonb_array_elements(v_live)
    loop
      continue when not (v_rule ->> 'mode' = 'package' or v_rule ->> 'type' = 'fixed_package');
      continue when not (
        exists (select 1 from jsonb_each(case when jsonb_typeof(v_rule -> 'vehicleServiceMatrix') = 'object' then v_rule -> 'vehicleServiceMatrix' else '{}' end) e
                 where lower(public.catalog_vehicle_key(e.key)) = lower(public.catalog_vehicle_key(v_vtype)))
        or ((jsonb_typeof(v_rule -> 'vehicleServiceMatrix') is distinct from 'object' or v_rule -> 'vehicleServiceMatrix' = '{}')
            and (jsonb_typeof(v_rule -> 'vehicleTypes') is distinct from 'array' or jsonb_array_length(v_rule -> 'vehicleTypes') = 0
                 or exists (select 1 from jsonb_array_elements_text(v_rule -> 'vehicleTypes') x where lower(public.catalog_vehicle_key(x)) = lower(public.catalog_vehicle_key(v_vtype))))));
      v_pkg_min := least(coalesce(v_pkg_min, (v_rule ->> 'value')::numeric), (v_rule ->> 'value')::numeric);
    end loop;
    if v_pkg_min is not null and v_pkg_min < v_std_floor - (case when v_code_type = 'percentage' then v_veh_code * least(v_code_value, 100) / 100 else 0 end) then
      v_floor := v_floor + v_pkg_min;
    else
      v_floor := v_floor + v_std_floor;
      v_code_eligible := v_code_eligible + v_veh_code;
    end if;
  end loop;

  if v_code_type = 'percentage' then
    v_floor := v_floor - v_code_eligible * least(v_code_value, 100) / 100;
  elsif v_code_type is not null then
    v_floor := v_floor - least(coalesce(v_code_value, 0), v_code_eligible);
  end if;
  v_floor := greatest(0, v_floor);

  if v_total < v_floor - 1.00 or v_total > v_standalone + 1.00 then
    raise exception 'The booking total does not match the current prices. Refresh the page and try again.'
      using errcode = '23514';
  end if;
end;
$function$;
