-- Deleting an account must never delete the shop's records. Bookings, their payments, refunds and the customer
-- credit history stay in the database; only the account itself (profile, sign-in, vehicles, chats, notifications,
-- drafts ...) is removed. A kept booking points at no account (customer_id is empty) and still carries the
-- customer's name, e-mail and phone that were saved on it when it was made.

-- 1. A booking no longer disappears with its customer.
alter table public.bookings drop constraint if exists bookings_customer_id_fkey;
alter table public.bookings
  add constraint bookings_customer_id_fkey foreign key (customer_id) references public.profiles(id) on delete set null;

-- 2. Neither does the credit history.
alter table public.customer_credit_ledger alter column customer_id drop not null;
alter table public.customer_credit_ledger drop constraint if exists customer_credit_ledger_customer_id_fkey;
alter table public.customer_credit_ledger
  add constraint customer_credit_ledger_customer_id_fkey foreign key (customer_id) references auth.users(id) on delete set null;

-- 3. The purge writes the customer's details onto their bookings first (older rows may not have them), then
--    deletes the account. Everything else works as before.
create or replace function public.purge_deactivated_accounts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grace integer;
  r record;
  c record;
  v_count integer := 0;
begin
  select coalesce(account_recovery_grace_days, 15) into v_grace from public.business_config order by id limit 1;

  for r in
    select id, email, upper(coalesce(role, '')) as role
      from public.profiles
     where coalesce(is_active, true) = false
       and deactivated_at is not null
       and deactivated_at < now() - make_interval(days => coalesce(v_grace, 15))
  loop
    begin
      -- keep who the booking was for, on the booking itself
      update public.bookings b
         set customer_name = coalesce(nullif(btrim(coalesce(b.customer_name, '')), ''),
                                      nullif(btrim(coalesce(p.full_name, '')), ''),
                                      nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')),
             customer_first_name = coalesce(nullif(btrim(coalesce(b.customer_first_name, '')), ''), nullif(btrim(coalesce(p.first_name, '')), '')),
             customer_last_name = coalesce(nullif(btrim(coalesce(b.customer_last_name, '')), ''), nullif(btrim(coalesce(p.last_name, '')), '')),
             customer_email = coalesce(nullif(btrim(coalesce(b.customer_email, '')), ''), nullif(btrim(coalesce(p.email, '')), '')),
             contact_number = coalesce(nullif(btrim(coalesce(b.contact_number, '')), ''), nullif(btrim(coalesce(p.phone_number, '')), ''))
        from public.profiles p
       where p.id = r.id and b.customer_id = r.id;

      -- anything that points at the account and would block its deletion: a nullable reference is cleared,
      -- a required one is removed with its row. Bookings, payments and credit history use "set null" and stay.
      for c in
        select con.conrelid::regclass as tbl, a.attname as col, a.attnotnull as required
          from pg_constraint con
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
         where con.contype = 'f'
           and con.confdeltype in ('a', 'r')
           and con.confrelid in ('public.profiles'::regclass, 'auth.users'::regclass)
           and con.connamespace = 'public'::regnamespace
      loop
        if c.required then
          execute format('delete from %s where %I = $1', c.tbl, c.col) using r.id;
        else
          execute format('update %s set %I = null where %I = $1', c.tbl, c.col, c.col) using r.id;
        end if;
      end loop;

      -- data kept by a plain id (no foreign key) is removed or made anonymous here
      delete from public.vehicles where owner_id = r.id;
      delete from public.notifications where user_id = r.id;
      delete from public.staff_shifts where staff_id = r.id;
      update public.audit_logs set actor_id = null, actor_name = 'Deleted account' where actor_id = r.id;
      update public.audit_trails set actor_id = null where actor_id = r.id;
      update public.booking_events set actor_id = null where actor_id = r.id;
      if r.email is not null then
        delete from public.invites where lower(email) = lower(r.email);
      end if;

      delete from auth.users where id = r.id;  -- the profile and the account's own data follow; the shop's records stay
      v_count := v_count + 1;

      insert into public.audit_logs (action_type, actor_name, actor_role, details)
      values ('ACCOUNT_PURGED', 'System', 'SYSTEM',
              format('A deactivated %s account was permanently deleted after the %s-day recovery period. Its bookings, payments and credit history were kept.', lower(r.role), coalesce(v_grace, 15)));
    exception when others then
      insert into public.audit_logs (action_type, actor_name, actor_role, details)
      values ('ACCOUNT_PURGE_FAILED', 'System', 'SYSTEM',
              format('A deactivated %s account could not be deleted yet: %s', lower(r.role), sqlerrm));
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.purge_deactivated_accounts() from public, anon, authenticated;
grant execute on function public.purge_deactivated_accounts() to service_role;
