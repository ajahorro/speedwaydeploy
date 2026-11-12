-- A booking must have an end time; without one it skipped the "time is full" check.
do $$
declare
  v_def text := pg_get_functiondef('public.create_booking_atomic(jsonb)'::regprocedure);
  v_old text := $o$or (v_booking ->> 'start_datetime') is null then$o$;
  v_new text := $n$or (v_booking ->> 'start_datetime') is null
     or (v_booking ->> 'end_datetime') is null then$n$;
begin
  if position('end_datetime'') is null' in v_def) > 0 then return; end if;
  if position(v_old in v_def) = 0 then raise exception 'create_booking_atomic changed; update this migration'; end if;
  execute replace(v_def, v_old, v_new);
end $$;
