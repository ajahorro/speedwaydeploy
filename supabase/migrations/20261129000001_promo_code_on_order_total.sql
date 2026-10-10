-- A promo code lessens the TOTAL of the order once; it is not taken off every service.
-- The booking price check applies the code after the per-service promotions, as one
-- percentage or one fixed amount, instead of folding it into the per-service factors.
do $patch$
declare
  v_def text;
begin
  select pg_get_functiondef('public.assert_booking_pricing(jsonb)'::regprocedure) into v_def;
  if position('v_code_factor' in v_def) > 0 then return; end if;

  v_def := replace(v_def, E'  v_code_row record;\n', E'  v_code_row record;\n  v_code_factor numeric := 1;\n  v_code_fixed numeric := 0;\n');
  v_def := replace(v_def,
    E'      if v_code_row.discount_type = ''percentage'' then v_factor := v_factor * (1 - least(v_code_row.discount_value, 100) / 100);\n      else v_fixed := v_fixed + v_code_row.discount_value; end if;',
    E'      if v_code_row.discount_type = ''percentage'' then v_code_factor := 1 - least(v_code_row.discount_value, 100) / 100;\n      else v_code_fixed := v_code_row.discount_value; end if;');
  v_def := replace(v_def,
    E'  if v_total < v_floor - 1.00',
    E'  v_floor := greatest(0, v_floor * v_code_factor - v_code_fixed);\n  if v_total < v_floor - 1.00');

  if position('v_code_factor := 1 - least' in v_def) = 0 or position('v_floor * v_code_factor' in v_def) = 0 or position('v_code_fixed numeric' in v_def) = 0 then
    raise exception 'assert_booking_pricing layout changed; promo code patch not installed';
  end if;
  execute v_def;
end
$patch$;
