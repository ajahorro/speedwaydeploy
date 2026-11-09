-- New accounts: the profile keeps the first name, last name and mobile number typed at sign-up (they were dropped,
-- leaving only the full name). The role now comes only from app metadata, which only the server can set; a public
-- sign-up is always a customer (before, anyone could ask for another role in their sign-up details).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_phone text := public.normalize_ph_phone(nullif(btrim(coalesce(m ->> 'phone_number', '')), ''));
begin
  if v_phone is not null and v_phone !~ '^09[0-9]{9}$' then
    v_phone := null;
  end if;
  insert into public.profiles (id, email, full_name, first_name, last_name, phone_number, role)
  values (
    new.id,
    new.email,
    coalesce(nullif(btrim(m ->> 'full_name'), ''), nullif(btrim(concat(m ->> 'first_name', ' ', m ->> 'last_name')), ''), 'Speedway User'),
    nullif(btrim(m ->> 'first_name'), ''),
    nullif(btrim(m ->> 'last_name'), ''),
    v_phone,
    coalesce(nullif(new.raw_app_meta_data ->> 'role', ''), 'CUSTOMER')
  )
  on conflict (id) do update set email = excluded.email;
  return new;
exception
  when others then return new;
end;
$$;
