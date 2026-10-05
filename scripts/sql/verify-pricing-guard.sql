-- Scratch-database test of the server-side price check (assert_booking_pricing / catalog_service_price).
--   docker exec -i <db-container> psql -U postgres < scripts/sql/verify-pricing-guard.sql
-- Everything runs in a transaction that is rolled back.
begin;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;

create or replace function pg_temp.expect(p_name text, p_payload jsonb, p_error text default null)
returns void language plpgsql as $$
begin
  begin
    perform public.assert_booking_pricing(p_payload);
    insert into t_results values (p_name, p_error is null, case when p_error is null then '' else 'accepted but should be refused' end);
  exception when others then
    insert into t_results values (p_name, p_error is not null and sqlerrm ilike '%' || p_error || '%', sqlerrm);
  end;
end $$;

create or replace function pg_temp.booking_code(p_total numeric, p_vehicle text, p_code text, p_service text)
returns jsonb language sql as $$
  select jsonb_build_object(
    'booking', jsonb_build_object('total_amount', p_total, 'promo_code', p_code),
    'vehicles', jsonb_build_array(jsonb_build_object(
      'vehicle', jsonb_build_object('vehicle_type', p_vehicle),
      'services', jsonb_build_array(jsonb_build_object('service_name', p_service)))));
$$;
create or replace function pg_temp.booking(p_total numeric, p_vehicle text, variadic p_services text[])
returns jsonb language sql as $$
  select jsonb_build_object(
    'booking', jsonb_build_object('total_amount', p_total),
    'vehicles', jsonb_build_array(jsonb_build_object(
      'vehicle', jsonb_build_object('vehicle_type', p_vehicle),
      'services', (select jsonb_agg(jsonb_build_object('service_name', s)) from unnest(p_services) s))));
$$;

-- a clean, known configuration
set local session_replication_role = replica;
update business_config set custom_services = '[]', archived_service_ids = '[]', deleted_service_ids = '[]', promo_rules = '[]';
delete from promo_codes;
set local session_replication_role = origin;

select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
set local role authenticated;

-- catalog prices (Regular Wash: Sedan 150, SUV 180; Supreme Wash Sedan 500)
select pg_temp.expect('exact catalog total is accepted', pg_temp.booking(150, 'Sedan', 'Regular Wash'));
select pg_temp.expect('two services add up', pg_temp.booking(650, 'Sedan', 'Regular Wash', 'Supreme Wash'));
select pg_temp.expect('vehicle aliases resolve (Motorcycle -> Regular)', pg_temp.booking(120, 'Motorcycle', 'Moto Wash'));
select pg_temp.expect('a tampered total of 1 is refused', pg_temp.booking(1, 'Sedan', 'Regular Wash'), 'does not match the current prices');
select pg_temp.expect('a total above the catalog is refused', pg_temp.booking(400, 'Sedan', 'Regular Wash'), 'does not match the current prices');
select pg_temp.expect('an unknown service is refused', pg_temp.booking(10, 'Sedan', 'Free Gold Plating'), 'not available');
select pg_temp.expect('a service with no price for that vehicle is refused', pg_temp.booking(100, 'Van/L300', 'Showroom Shine (Pkg 1)'), 'not available');

-- Business Hub edits layer on top of the built-ins
set local role postgres;
update business_config set custom_services = jsonb_build_array(
  jsonb_build_object('name', 'Regular Wash', 'vehicleType', 'Sedan', 'price', 99, 'is_active', true, 'archived', false),
  jsonb_build_object('name', 'Supreme Wash', 'vehicleType', 'Sedan', 'price', 500, 'is_active', true, 'archived', true),
  jsonb_build_object('name', 'Window Tint', 'applicableVehicleTypes', jsonb_build_array('Sedan', 'SUV'), 'price', 2000, 'is_active', true, 'archived', false));
set local role authenticated;
select pg_temp.expect('an edited price replaces the built-in price', pg_temp.booking(99, 'Sedan', 'Regular Wash'));
select pg_temp.expect('the old built-in price is now above the catalog', pg_temp.booking(150, 'Sedan', 'Regular Wash'), 'does not match');
select pg_temp.expect('an archived service is refused', pg_temp.booking(500, 'Sedan', 'Supreme Wash'), 'not available');
select pg_temp.expect('a custom service works for each vehicle type it lists', pg_temp.booking(2000, 'SUV', 'Window Tint'));
select pg_temp.expect('a custom service is refused for other vehicle types', pg_temp.booking(2000, 'Regular', 'Window Tint'), 'not available');

-- tombstones for built-ins
set local role postgres;
update business_config set custom_services = '[]', archived_service_ids = '["wash_1-Sedan"]', deleted_service_ids = '["ext_1"]';
set local role authenticated;
select pg_temp.expect('an archived built-in variant is refused for that vehicle', pg_temp.booking(150, 'Sedan', 'Regular Wash'), 'not available');
select pg_temp.expect('the same service still works for other vehicles', pg_temp.booking(180, 'SUV', 'Regular Wash'));
select pg_temp.expect('a deleted built-in is refused everywhere', pg_temp.booking(1000, 'Sedan', 'Spot Removal'), 'not available');

-- promotions: a lower bound, never refusing a legitimate discount
set local role postgres;
update business_config set archived_service_ids = '[]', deleted_service_ids = '[]', promo_rules = jsonb_build_array(
  jsonb_build_object('id', 'p1', 'type', 'percentage', 'value', 10, 'active', true, 'name', '10 off'),
  jsonb_build_object('id', 'p2', 'type', 'percentage', 'value', 50, 'active', true, 'deleted_at', '2020-01-01T00:00:00Z', 'name', 'deleted'),
  jsonb_build_object('id', 'p3', 'type', 'percentage', 'value', 50, 'active', true, 'validUntil', '2020-01-01T00:00:00Z', 'name', 'expired'),
  jsonb_build_object('id', 'p4', 'mode', 'package', 'type', 'fixed_package', 'value', 500, 'active', true, 'name', 'bundle'));
set local role authenticated;
select pg_temp.expect('a live percentage promo price is accepted', pg_temp.booking(135, 'Sedan', 'Regular Wash'));
select pg_temp.expect('a live package price is accepted', pg_temp.booking(500, 'Sedan', 'Regular Wash', 'Supreme Wash'));
select pg_temp.expect('below the best live promo/package is refused', pg_temp.booking(50, 'Sedan', 'Regular Wash', 'Supreme Wash'), 'does not match');
select pg_temp.expect('a deleted or expired promo gives no extra room', pg_temp.booking(60, 'Sedan', 'Regular Wash'), 'does not match');

set local role postgres;
update business_config set promo_rules = '[]';
insert into promo_codes (code, name, discount_type, discount_value) values ('GUARD25', 'guard', 'percentage', 25);
set local role authenticated;
select pg_temp.expect('a coded promotion price is accepted with its code', pg_temp.booking_code(112.5, 'Sedan', 'guard25', 'Regular Wash'));
select pg_temp.expect('below the coded promotion is refused', pg_temp.booking_code(100, 'Sedan', 'GUARD25', 'Regular Wash'), 'does not match');
select pg_temp.expect('the coded price is refused without the code', pg_temp.booking(112.5, 'Sedan', 'Regular Wash'), 'does not match');

-- server jobs without a user session are not checked
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.expect('no session: not checked', pg_temp.booking(1, 'Sedan', 'Regular Wash'));

\o
select name, case when ok then 'PASS' else 'FAIL' end as result, detail from t_results order by 2 desc, 1;
rollback;
