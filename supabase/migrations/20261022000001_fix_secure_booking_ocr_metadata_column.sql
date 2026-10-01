-- payments has no ocr_metadata column; the complete OCR payload is already
-- persisted on bookings by create_booking_atomic.
do $$
declare
  v_function_definition text;
  v_invalid_assignment text := 'ocr_metadata = coalesce(ocr_metadata, ''{}''::jsonb) || v_metadata,';
begin
  select pg_get_functiondef('public.create_booking_atomic_secure(jsonb)'::regprocedure)
    into v_function_definition;

  if strpos(v_function_definition, v_invalid_assignment) > 0 then
    execute replace(v_function_definition, v_invalid_assignment, '');
  end if;
end;
$$;