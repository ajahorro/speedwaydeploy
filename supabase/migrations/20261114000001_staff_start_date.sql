-- ============================================================================
-- The staff "joined" date is the day the account officially became a staff (or administrator) account.
-- It is set by the database at that moment, in the shop's time zone, and is no longer typed in by hand.
-- Existing dates are left as they are.
-- ============================================================================
create or replace function public.set_staff_start_date()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if upper(coalesce(new.role::text, '')) in ('STAFF', 'ADMIN')
     and (tg_op = 'INSERT' or upper(coalesce(old.role::text, '')) not in ('STAFF', 'ADMIN')) then
    new.hired_at := (now() at time zone public.shop_timezone())::date;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_staff_start_date on public.profiles;
create trigger trg_set_staff_start_date
  before insert or update of role on public.profiles
  for each row execute function public.set_staff_start_date();
