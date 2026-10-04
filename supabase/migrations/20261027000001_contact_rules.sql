-- ============================================================================
-- Phone and email rules enforced where the data is stored.
--
-- The forms validate first (frontend/src/utils/contactValidation.js) and the
-- backend validates its own routes, but any writer that bypasses them (a direct
-- API call, a future screen) used to be able to store "abc" as a phone number or
-- "name" as an email. These triggers are the last line.
--
-- Phone: a Philippine mobile number stored as 11 digits starting with 09. Typed
--        forms such as +63 912 345 6789 are normalised to 09123456789.
-- Email: trimmed, lower-case, one @, dotted domain with a 2+ letter ending.
--
-- Rows that already hold an older format are left alone: the triggers only look
-- at a value when it is inserted or CHANGED, so existing accounts, bookings and
-- logins keep working, and the value is fixed whenever it is next edited.
-- ============================================================================

create or replace function public.normalize_ph_phone(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_value is null then null
    else (
      select case
        when d ~ '^63[0-9]{10}$' then '0' || substr(d, 3)
        when d ~ '^9[0-9]{9}$' then '0' || d
        else d
      end
      from (select regexp_replace(p_value, '\D', '', 'g') as d) s
    )
  end;
$$;

create or replace function public.is_valid_email(p_value text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_value is not null
     and length(lower(btrim(p_value))) <= 254
     and lower(btrim(p_value)) ~ '^[a-z0-9]([a-z0-9._%+-]*[a-z0-9])?@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'
     and position('..' in p_value) = 0;
$$;

-- One checker used by every table trigger below.
create or replace function public.enforce_contact_rules()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_col text;
  v_value text;
  v_clean text;
begin
  -- TG_ARGV: 'phone:<column>' or 'email:<column>'
  for i in 0 .. tg_nargs - 1 loop
    v_col := split_part(tg_argv[i], ':', 2);
    v_value := v_new ->> v_col;

    if v_value is null or btrim(v_value) = '' then
      continue;
    end if;
    if tg_op = 'UPDATE' and (v_old ->> v_col) is not distinct from v_value then
      continue;
    end if;

    if split_part(tg_argv[i], ':', 1) = 'phone' then
      v_clean := public.normalize_ph_phone(v_value);
      if v_clean !~ '^09[0-9]{9}$' then
        raise exception 'Enter an 11-digit mobile number starting with 09.'
          using errcode = 'check_violation', column = v_col;
      end if;
    else
      if not public.is_valid_email(v_value) then
        raise exception 'Enter a valid email address.'
          using errcode = 'check_violation', column = v_col;
      end if;
      v_clean := lower(btrim(v_value));
    end if;

    new := jsonb_populate_record(new, jsonb_build_object(v_col, v_clean));
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_contact_rules on public.profiles;
create trigger trg_contact_rules
  before insert or update of phone_number on public.profiles
  for each row execute function public.enforce_contact_rules('phone:phone_number');

drop trigger if exists trg_contact_rules on public.bookings;
create trigger trg_contact_rules
  before insert or update of contact_number, customer_phone, guest_phone, customer_email, guest_email on public.bookings
  for each row execute function public.enforce_contact_rules(
    'phone:contact_number', 'phone:customer_phone', 'phone:guest_phone',
    'email:customer_email', 'email:guest_email'
  );

drop trigger if exists trg_contact_rules on public.pending_registrations;
create trigger trg_contact_rules
  before insert or update of phone, email on public.pending_registrations
  for each row execute function public.enforce_contact_rules('phone:phone', 'email:email');
