-- ============================================================================
-- Server-side check of booking prices (master plan 4.5 follow-up).
--
-- Until now the browser worked out every price and total and the database stored whatever it was
-- sent, so a tampered request could book a ₱3,500 package for ₱1. The database now knows the
-- catalog and refuses a booking whose services or total cannot have come from it:
--   * every service must exist for that vehicle type, not archived/deleted/inactive;
--   * the total can never be below the lowest price the live promotions could produce, and never
--     above the catalog prices (the check is a LOWER BOUND on discounts, so a legitimate booking
--     is never refused: it ignores which exact promo matched and assumes every live one could);
--   * a coded promotion is checked by its own validity rules (trigger bookings_apply_promo_code).
--
-- The built-in catalog is stored in catalog_builtin_services (generated from
-- frontend/src/data/servicesCatalog.js by scripts/gen-catalog-seed.mjs; scripts/verify-catalog-sync.mjs
-- fails if they differ). Admin edits in the Business Hub (business_config.custom_services plus the
-- archived/deleted id lists) are layered on top by catalog_service_price(), mirroring the browser.
-- ============================================================================
create table if not exists public.catalog_builtin_services (
  service_id text not null,
  name text not null,
  category text,
  vehicle_key text not null,
  price numeric not null check (price > 0),
  primary key (service_id, vehicle_key)
);
alter table public.catalog_builtin_services enable row level security;
revoke all on public.catalog_builtin_services from anon, authenticated;

delete from public.catalog_builtin_services;
insert into public.catalog_builtin_services (service_id, name, category, vehicle_key, price) values
  ('pkg_1', 'Showroom Shine (Pkg 1)', 'Exclusive Packages', 'Sedan', 2500),
  ('pkg_1', 'Showroom Shine (Pkg 1)', 'Exclusive Packages', 'SUV', 3500),
  ('pkg_2', 'Ultimate Protection (Pkg 2)', 'Exclusive Packages', 'Sedan', 3500),
  ('pkg_2', 'Ultimate Protection (Pkg 2)', 'Exclusive Packages', 'SUV', 4500),
  ('wash_1', 'Regular Wash', 'Premium Car Wash', 'Sedan', 150),
  ('wash_1', 'Regular Wash', 'Premium Car Wash', 'SUV', 180),
  ('wash_1', 'Regular Wash', 'Premium Car Wash', 'Van/L300', 300),
  ('wash_2', 'Supreme Wash', 'Premium Car Wash', 'Sedan', 500),
  ('wash_2', 'Supreme Wash', 'Premium Car Wash', 'SUV', 600),
  ('wash_2', 'Supreme Wash', 'Premium Car Wash', 'Van/L300', 800),
  ('ext_1', 'Spot Removal', 'Specialized Exterior Care', 'Sedan', 1000),
  ('ext_1', 'Spot Removal', 'Specialized Exterior Care', 'SUV', 1500),
  ('ext_1', 'Spot Removal', 'Specialized Exterior Care', 'Van/L300', 2000),
  ('ext_2', 'Acid Rain Removal (Hand)', 'Specialized Exterior Care', 'Sedan', 600),
  ('ext_2', 'Acid Rain Removal (Hand)', 'Specialized Exterior Care', 'SUV', 800),
  ('ext_2', 'Acid Rain Removal (Hand)', 'Specialized Exterior Care', 'Van/L300', 1000),
  ('ext_3', 'Acid Rain Removal (Machine)', 'Specialized Exterior Care', 'Sedan', 1000),
  ('ext_3', 'Acid Rain Removal (Machine)', 'Specialized Exterior Care', 'SUV', 1500),
  ('ext_3', 'Acid Rain Removal (Machine)', 'Specialized Exterior Care', 'Van/L300', 2000),
  ('ext_4', 'Engine Wash', 'Specialized Exterior Care', 'Sedan', 500),
  ('ext_4', 'Engine Wash', 'Specialized Exterior Care', 'SUV', 800),
  ('ext_4', 'Engine Wash', 'Specialized Exterior Care', 'Van/L300', 1000),
  ('ext_5', 'Headlight Polish', 'Specialized Exterior Care', 'Sedan', 800),
  ('ext_5', 'Headlight Polish', 'Specialized Exterior Care', 'SUV', 1000),
  ('ext_5', 'Headlight Polish', 'Specialized Exterior Care', 'Van/L300', 1300),
  ('ext_6', 'Asphalt Removal', 'Specialized Exterior Care', 'Sedan', 700),
  ('ext_6', 'Asphalt Removal', 'Specialized Exterior Care', 'SUV', 900),
  ('ext_6', 'Asphalt Removal', 'Specialized Exterior Care', 'Van/L300', 1200),
  ('ext_7', 'Buff Wax (Machine)', 'Specialized Exterior Care', 'Sedan', 1000),
  ('ext_7', 'Buff Wax (Machine)', 'Specialized Exterior Care', 'SUV', 1500),
  ('ext_7', 'Buff Wax (Machine)', 'Specialized Exterior Care', 'Van/L300', 2500),
  ('ext_8', 'Mags Detailing', 'Specialized Exterior Care', 'Sedan', 1200),
  ('ext_8', 'Mags Detailing', 'Specialized Exterior Care', 'SUV', 2000),
  ('ext_8', 'Mags Detailing', 'Specialized Exterior Care', 'Van/L300', 2800),
  ('int_1', 'Interior Detailing', 'Interior & Cabin Care', 'Sedan', 4500),
  ('int_1', 'Interior Detailing', 'Interior & Cabin Care', 'SUV', 5500),
  ('int_1', 'Interior Detailing', 'Interior & Cabin Care', 'Van/L300', 6500),
  ('int_2', 'Back to Zero', 'Interior & Cabin Care', 'Sedan', 350),
  ('int_2', 'Back to Zero', 'Interior & Cabin Care', 'SUV', 400),
  ('int_2', 'Back to Zero', 'Interior & Cabin Care', 'Van/L300', 600),
  ('int_3', 'Seat Cover In/Out', 'Interior & Cabin Care', 'Sedan', 500),
  ('int_3', 'Seat Cover In/Out', 'Interior & Cabin Care', 'SUV', 800),
  ('int_3', 'Seat Cover In/Out', 'Interior & Cabin Care', 'Van/L300', 1200),
  ('int_4', 'Ceiling Cleaning', 'Interior & Cabin Care', 'Sedan', 700),
  ('int_4', 'Ceiling Cleaning', 'Interior & Cabin Care', 'SUV', 1000),
  ('int_4', 'Ceiling Cleaning', 'Interior & Cabin Care', 'Van/L300', 1300),
  ('det_1', 'Ceramic Coating', 'Professional Detailing', 'Sedan', 10000),
  ('det_1', 'Ceramic Coating', 'Professional Detailing', 'SUV', 13000),
  ('det_1', 'Ceramic Coating', 'Professional Detailing', 'Van/L300', 16000),
  ('det_2', 'Exterior Detailing (3 Step)', 'Professional Detailing', 'Sedan', 5000),
  ('det_2', 'Exterior Detailing (3 Step)', 'Professional Detailing', 'SUV', 6000),
  ('det_2', 'Exterior Detailing (3 Step)', 'Professional Detailing', 'Van/L300', 7000),
  ('det_3', '1st Step Cutting', 'Professional Detailing', 'Sedan', 2500),
  ('det_3', '1st Step Cutting', 'Professional Detailing', 'SUV', 3000),
  ('det_3', '1st Step Cutting', 'Professional Detailing', 'Van/L300', 3500),
  ('det_4', 'Glass Detailing', 'Professional Detailing', 'Sedan', 3500),
  ('det_4', 'Glass Detailing', 'Professional Detailing', 'SUV', 4500),
  ('det_4', 'Glass Detailing', 'Professional Detailing', 'Van/L300', 6000),
  ('moto_1', 'Moto Wash', 'Motorcycle Specialist', 'Regular', 120),
  ('moto_1', 'Moto Wash', 'Motorcycle Specialist', 'Bigbike', 150),
  ('moto_2', 'Moto VIP', 'Motorcycle Specialist', 'Regular', 250),
  ('moto_2', 'Moto VIP', 'Motorcycle Specialist', 'Bigbike', 350),
  ('moto_3', 'Moto Detail', 'Motorcycle Specialist', 'Regular', 2500),
  ('moto_3', 'Moto Detail', 'Motorcycle Specialist', 'Bigbike', 3000),
  ('moto_4', 'Moto Ceramic Coating', 'Motorcycle Specialist', 'Regular', 3500),
  ('moto_4', 'Moto Ceramic Coating', 'Motorcycle Specialist', 'Bigbike', 5500),
  ('moto_5', 'Moto 3-Step Detailing', 'Motorcycle Specialist', 'Regular', 2500),
  ('moto_5', 'Moto 3-Step Detailing', 'Motorcycle Specialist', 'Bigbike', 3500),
  ('add_1', 'Waxx Add-on', 'Add-on Treatments', 'Sedan', 200),
  ('add_1', 'Waxx Add-on', 'Add-on Treatments', 'SUV', 300),
  ('add_1', 'Waxx Add-on', 'Add-on Treatments', 'Van/L300', 400),
  ('add_2', 'Highgloss Add-on', 'Add-on Treatments', 'Sedan', 200),
  ('add_2', 'Highgloss Add-on', 'Add-on Treatments', 'SUV', 300),
  ('add_2', 'Highgloss Add-on', 'Add-on Treatments', 'Van/L300', 400),
  ('add_3', 'Degreaser Add-on', 'Add-on Treatments', 'Sedan', 200),
  ('add_3', 'Degreaser Add-on', 'Add-on Treatments', 'SUV', 300),
  ('add_3', 'Degreaser Add-on', 'Add-on Treatments', 'Van/L300', 400);

-- Canonical vehicle category key (same aliases as the browser's priceVehicleKey).
create or replace function public.catalog_vehicle_key(p_value text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_raw text := btrim(coalesce(p_value, ''));
  v_norm text;
  v_flat text;
begin
  if v_raw = '' then return ''; end if;
  v_norm := btrim(regexp_replace(regexp_replace(lower(v_raw), '[_/-]+', ' ', 'g'), '\s+', ' ', 'g'));
  v_flat := replace(v_norm, ' ', '');
  return case
    when v_norm = 'sedan' or v_flat = 'sedan' then 'Sedan'
    when v_norm = 'suv' then 'SUV'
    when v_norm in ('van l300', 'van', 'pickup', 'pickup van') or v_flat in ('vanl300', 'pickupvan') then 'Van/L300'
    when v_norm in ('regular', 'motorcycle', 'motorcycle regular', 'moto') or v_flat in ('motorcycleregular') then 'Regular'
    when v_norm in ('bigbike', 'big bike') or v_flat = 'bigbike' then 'Bigbike'
    else v_raw
  end;
end;
$$;

-- The price the shop charges for one service on one vehicle type right now, or NULL when it is not
-- offered (unknown, archived, deleted or inactive). Mirrors the browser's catalog merge: an admin
-- row for the same service and vehicle type wins over the built-in one.
create or replace function public.catalog_service_price(p_name text, p_vehicle_type text)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text := public.catalog_vehicle_key(p_vehicle_type);
  v_name text := lower(btrim(coalesce(p_name, '')));
  v_custom jsonb;
  v_archived_json jsonb;
  v_deleted_json jsonb;
  v_archived text[] := '{}';
  v_deleted text[] := '{}';
  e jsonb;
  v_types text[];
  v_found boolean := false;
  v_suppressed boolean := false;
  v_price numeric;
  b record;
begin
  if v_name = '' or v_key = '' then return null; end if;

  select coalesce(custom_services, '[]'::jsonb), coalesce(archived_service_ids, '[]'::jsonb), coalesce(deleted_service_ids, '[]'::jsonb)
    into v_custom, v_archived_json, v_deleted_json
    from public.business_config order by id limit 1;
  v_custom := coalesce(v_custom, '[]'::jsonb);
  if jsonb_typeof(v_archived_json) = 'array' then
    select coalesce(array_agg(x), '{}') into v_archived from jsonb_array_elements_text(v_archived_json) x;
  end if;
  if jsonb_typeof(v_deleted_json) = 'array' then
    select coalesce(array_agg(x), '{}') into v_deleted from jsonb_array_elements_text(v_deleted_json) x;
  end if;

  for e in select * from jsonb_array_elements(case when jsonb_typeof(v_custom) = 'array' then v_custom else '[]'::jsonb end)
  loop
    continue when lower(btrim(coalesce(e ->> 'name', ''))) <> v_name;
    select coalesce(array_agg(public.catalog_vehicle_key(t)), '{}') into v_types
      from jsonb_array_elements_text(coalesce(
        case when jsonb_typeof(e -> 'applicableVehicleTypes') = 'array' then e -> 'applicableVehicleTypes' end,
        case when jsonb_typeof(e -> 'vehicleTypes') = 'array' then e -> 'vehicleTypes' end,
        jsonb_build_array(coalesce(e ->> 'vehicleType', e ->> 'vehicle_type', ''))
      )) as t
     where btrim(t) <> '';
    if cardinality(v_types) = 0 then v_types := array['Sedan']; end if;
    continue when not (v_key = any (v_types));
    v_found := true;
    v_suppressed := coalesce((e ->> 'is_active')::boolean, true) = false or coalesce((e ->> 'archived')::boolean, false);
    begin v_price := (e ->> 'price')::numeric; exception when others then v_price := null; end;
  end loop;

  if v_found then
    if v_suppressed or coalesce(v_price, 0) <= 0 then return null; end if;
    return v_price;
  end if;

  select * into b from public.catalog_builtin_services
   where lower(name) = v_name and vehicle_key = v_key limit 1;
  if not found then return null; end if;
  if b.service_id = any (v_archived) or b.service_id = any (v_deleted)
     or (b.service_id || '-' || v_key) = any (v_archived) or (b.service_id || '-' || v_key) = any (v_deleted)
     or (b.name || '-' || v_key) = any (v_archived) or (b.name || '-' || v_key) = any (v_deleted) then
    return null;
  end if;
  return b.price;
end;
$$;

revoke all on function public.catalog_vehicle_key(text) from public;
revoke all on function public.catalog_service_price(text, text) from public, anon;
grant execute on function public.catalog_vehicle_key(text) to authenticated, service_role;
grant execute on function public.catalog_service_price(text, text) to authenticated, service_role;

-- The booking check. Callers without a user session (server jobs) are not checked.
create or replace function public.assert_booking_pricing(p_payload jsonb)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total numeric := nullif(p_payload #>> '{booking,total_amount}', '')::numeric;
  v_code text := nullif(btrim(coalesce(p_payload #>> '{booking,promo_code}', '')), '');
  v_rules jsonb;
  v_rule jsonb;
  v_factor numeric := 1;
  v_fixed numeric := 0;
  v_pkg_min numeric;
  v_value numeric;
  v_vehicle jsonb;
  v_line jsonb;
  v_price numeric;
  v_standalone numeric := 0;
  v_floor numeric := 0;
  v_veh_sum numeric;
  v_veh_lines integer;
  v_std_floor numeric;
  v_code_row record;
  v_from timestamptz;
  v_until timestamptz;
begin
  if auth.uid() is null then return; end if;
  if v_total is null or v_total < 0 then
    raise exception 'A valid booking total is required.' using errcode = '23514';
  end if;

  -- Live promotions (assume every one could apply: a lower bound on the price).
  select coalesce(promo_rules, '[]'::jsonb) into v_rules from public.business_config order by id limit 1;
  for v_rule in select * from jsonb_array_elements(case when jsonb_typeof(coalesce(v_rules, '[]'::jsonb)) = 'array' then v_rules else '[]'::jsonb end)
  loop
    continue when coalesce((v_rule ->> 'active')::boolean, true) = false
               or coalesce((v_rule ->> 'is_active')::boolean, true) = false
               or v_rule ? 'deleted_at' and nullif(v_rule ->> 'deleted_at', '') is not null;
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
    if v_rule ->> 'mode' = 'package' or v_rule ->> 'type' = 'fixed_package' then
      v_pkg_min := least(coalesce(v_pkg_min, v_value), v_value);
    elsif v_rule ->> 'type' = 'percentage' then
      v_factor := v_factor * (1 - least(v_value, 100) / 100);
    elsif v_rule ->> 'type' = 'fixed' then
      v_fixed := v_fixed + v_value;
    end if;
  end loop;

  -- A coded promotion on this booking adds its own discount.
  if v_code is not null then
    select discount_type, discount_value into v_code_row
      from public.promo_codes where lower(btrim(code)) = lower(v_code) limit 1;
    if found then
      if v_code_row.discount_type = 'percentage' then v_factor := v_factor * (1 - least(v_code_row.discount_value, 100) / 100);
      else v_fixed := v_fixed + v_code_row.discount_value; end if;
    end if;
  end if;

  for v_vehicle in select * from jsonb_array_elements(coalesce(p_payload -> 'vehicles', '[]'::jsonb))
  loop
    v_veh_sum := 0;
    v_veh_lines := 0;
    for v_line in select * from jsonb_array_elements(coalesce(v_vehicle -> 'services', '[]'::jsonb))
    loop
      v_price := public.catalog_service_price(v_line ->> 'service_name', v_vehicle #>> '{vehicle,vehicle_type}');
      if v_price is null then
        raise exception 'The service "%" is not available for this vehicle type. Refresh and choose again.', coalesce(v_line ->> 'service_name', '?')
          using errcode = '23514';
      end if;
      v_veh_sum := v_veh_sum + v_price;
      v_veh_lines := v_veh_lines + 1;
    end loop;
    v_std_floor := greatest(0, v_veh_sum * v_factor - v_fixed * v_veh_lines);
    v_floor := v_floor + case when v_pkg_min is not null then least(v_std_floor, v_pkg_min) else v_std_floor end;
    v_standalone := v_standalone + v_veh_sum;
  end loop;

  if v_total < v_floor - 1.00 or v_total > v_standalone + 1.00 then
    raise exception 'The booking total does not match the current prices. Refresh the page and try again.'
      using errcode = '23514';
  end if;
end;
$$;

revoke all on function public.assert_booking_pricing(jsonb) from public, anon;
grant execute on function public.assert_booking_pricing(jsonb) to authenticated, service_role;

-- Run the check at the start of the secure booking function.
do $patch$
declare
  v_def text;
  v_old text := E'begin\n  v_payment := v_payload -> ''payment'';';
  v_new text := E'begin\n  perform public.assert_booking_pricing(v_payload);\n  v_payment := v_payload -> ''payment'';';
begin
  select pg_get_functiondef('public.create_booking_atomic_secure(jsonb)'::regprocedure) into v_def;
  if position('assert_booking_pricing' in v_def) > 0 then return; end if;
  if position(v_old in v_def) = 0 then
    raise exception 'create_booking_atomic_secure layout changed; pricing check not installed';
  end if;
  execute replace(v_def, v_old, v_new);
end
$patch$;
