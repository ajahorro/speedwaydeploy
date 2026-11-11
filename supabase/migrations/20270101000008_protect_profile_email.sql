-- The sign-in email changes only through the verified email-change flow (server), never straight from the browser:
-- a hand-edited profile email would also pull in guest bookings made with that address.
do $$
declare v_def text := pg_get_functiondef('public.guard_profile_privileged_columns()'::regprocedure);
begin
  if position('''email'', ' in v_def) > 0 then return; end if;
  execute replace(v_def, 'v_protected text[] := array[', 'v_protected text[] := array[''email'', ');
end $$;
