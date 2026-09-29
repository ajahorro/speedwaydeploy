-- Allow the owner-only first-login RPCs to clear their caller's password gate
-- without weakening the profile's privileged-column trigger for other writes.

create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_protected text[] := array[
    'role', 'is_active', 'deactivated_at', 'failed_login_attempts',
    'locked_until', 'must_change_password', 'is_clocked_in',
    'clock_in_timestamp', 'email_change_temp', 'role_version'
  ];
  v_col text;
  v_old jsonb;
  v_new jsonb;
  v_is_admin boolean;
  v_is_service boolean;
  v_first_login_flag_clear boolean;
begin
  v_is_service := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';
  if v_is_service then
    return new;
  end if;

  v_is_admin := public.is_admin();
  v_first_login_flag_clear := coalesce(current_setting('app.allow_first_login_flag_clear', true), '') = 'true'
    and auth.uid() is not null
    and old.id = auth.uid()
    and new.id = old.id
    and old.must_change_password is distinct from false
    and new.must_change_password is false;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  foreach v_col in array v_protected loop
    if not v_is_admin and (v_new -> v_col) is distinct from (v_old -> v_col) then
      if v_col = 'must_change_password' and v_first_login_flag_clear then
        continue;
      end if;
      raise exception 'Column % is protected and may only be changed by an administrator.', v_col
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  return new;
end;
$$;

create or replace function public.complete_first_login_password_change()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform set_config('app.allow_first_login_flag_clear', 'true', true);
  update public.profiles
     set must_change_password = false,
         updated_at = now()
   where id = auth.uid();

  return jsonb_build_object('cleared', true);
end;
$$;

revoke all on function public.complete_first_login_password_change() from public;
grant execute on function public.complete_first_login_password_change() to authenticated, service_role;

create or replace function public.clear_first_login_flag()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform set_config('app.allow_first_login_flag_clear', 'true', true);
  update public.profiles
     set must_change_password = false,
         updated_at = now()
   where id = auth.uid()
     and coalesce(must_change_password, false) = true;

  select coalesce(must_change_password, false)
    into v_now
    from public.profiles
   where id = auth.uid();

  return jsonb_build_object(
    'cleared', coalesce(v_now, false) = false,
    'must_change_password', coalesce(v_now, false)
  );
end;
$$;

revoke all on function public.clear_first_login_flag() from public;
grant execute on function public.clear_first_login_flag() to authenticated, service_role;
