-- 4.8 Admin edits staff details: birthday and hire date. The hire date is an administrative
-- record, so (like role) only an administrator may change it.
alter table public.profiles
  add column if not exists birthday date,
  add column if not exists hired_at date;

update public.profiles
   set hired_at = created_at::date
 where hired_at is null and upper(coalesce(role, '')) in ('STAFF', 'ADMIN');

alter table public.profiles
  drop constraint if exists profiles_birthday_sane;
alter table public.profiles
  add constraint profiles_birthday_sane check (birthday is null or (birthday <= current_date and birthday >= date '1900-01-01'));

do $patch$
declare
  v_def text;
  v_old text := '''clock_in_timestamp'', ''email_change_temp'', ''role_version''';
  v_new text := '''clock_in_timestamp'', ''email_change_temp'', ''role_version'', ''hired_at''';
begin
  select pg_get_functiondef('public.guard_profile_privileged_columns()'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then
    raise exception 'guard_profile_privileged_columns layout changed; patch not applied';
  end if;
  execute replace(v_def, v_old, v_new);
end
$patch$;
