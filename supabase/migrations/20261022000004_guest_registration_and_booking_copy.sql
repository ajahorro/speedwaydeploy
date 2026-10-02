-- Preserve walk-in contact identity for account creation and link confirmed
-- customer registrations to their existing guest bookings.
alter table public.bookings
  add column if not exists customer_first_name text,
  add column if not exists customer_last_name text;

do $booking_rpc$
declare
  v_oid oid;
  v_source text;
  v_patched text;
  v_columns text := 'contact_number, customer_name, customer_email, notes, ocr_metadata,';
  v_values text;
begin
  select p.oid
    into v_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'create_booking_atomic'
     and p.pronargs = 1
   limit 1;

  if v_oid is null then
    raise exception 'create_booking_atomic(jsonb) was not found; refusing to omit walk-in registration names.';
  end if;

  v_source := pg_get_functiondef(v_oid);
  if position('customer_first_name' in v_source) > 0 then
    raise notice 'create_booking_atomic already stores walk-in registration names.';
    return;
  end if;

  v_values :=
    'v_booking ->> ' || quote_literal('customer_email') || ',' || chr(10) ||
    '    v_booking ->> ' || quote_literal('notes') || ',';

  if position(v_columns in v_source) = 0 or position(v_values in v_source) = 0 then
    raise exception 'Could not safely patch create_booking_atomic() to store walk-in registration names.';
  end if;

  v_patched := replace(
    v_source,
    v_columns,
    'contact_number, customer_name, customer_email, customer_first_name, customer_last_name, notes, ocr_metadata,'
  );
  v_patched := replace(
    v_patched,
    v_values,
    'v_booking ->> ' || quote_literal('customer_email') || ',' || chr(10) ||
    '    v_booking ->> ' || quote_literal('customer_first_name') || ',' || chr(10) ||
    '    v_booking ->> ' || quote_literal('customer_last_name') || ',' || chr(10) ||
    '    v_booking ->> ' || quote_literal('notes') || ','
  );
  execute v_patched;
end;
$booking_rpc$;

create or replace function public.link_guest_bookings_to_customer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if upper(coalesce(new.role::text, '')) = 'CUSTOMER'
     and nullif(btrim(new.email), '') is not null then
    update public.bookings
       set customer_id = new.id,
           updated_at = now()
     where customer_id is null
       and lower(btrim(coalesce(customer_email, ''))) = lower(btrim(new.email));
  end if;

  return new;
end;
$$;

drop trigger if exists trg_link_guest_bookings_to_customer on public.profiles;
create trigger trg_link_guest_bookings_to_customer
after insert or update of email, role on public.profiles
for each row
execute function public.link_guest_bookings_to_customer();

-- Repair guest bookings made before the account-registration flow was linked.
update public.bookings b
   set customer_id = p.id,
       updated_at = now()
  from public.profiles p
 where b.customer_id is null
   and upper(coalesce(p.role::text, '')) = 'CUSTOMER'
   and lower(btrim(coalesce(b.customer_email, ''))) = lower(btrim(p.email));

-- Keep older installations' atomic booking audit wording understandable too.
do $audit_copy$
declare
  v_oid oid;
  v_source text;
  v_patched text;
begin
  select p.oid
    into v_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'mutate_booking_locked'
     and p.pronargs = 9
   limit 1;

  if v_oid is null then
    raise notice 'mutate_booking_locked() not found; audit wording patch skipped.';
    return;
  end if;

  v_source := pg_get_functiondef(v_oid);
  v_patched := replace(v_source, quote_literal('BOOKING_MUTATED'), quote_literal('BOOKING_UPDATED'));
  v_patched := replace(v_patched, 'Booking mutated:', 'Booking updated:');

  if v_patched <> v_source then
    execute v_patched;
  end if;
end;
$audit_copy$;
