-- A failed sign-in only ever locks the address it came from. The whole-account hold (5 or more addresses failing
-- within an hour) let a stranger lock someone else out on purpose, so it is removed; the owner's own address and the
-- emailed security notice still work as before.
do $$
declare
  v_def text := pg_get_functiondef('public.register_failed_login_staged(text)'::regprocedure);
  v_new text := regexp_replace(v_def, '\n  -- a spread-out attack.*?\n  end if;\n', E'\n');
begin
  if v_new = v_def then
    raise exception 'register_failed_login_staged has changed; update this migration';
  end if;
  execute v_new;
end $$;

-- lift any whole-account hold that is still running
select set_config('app.allow_lockout_write', 'true', true);
update public.profiles set locked_until = null where locked_until > now();
