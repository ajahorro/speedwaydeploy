-- Deactivation is the only way an account is removed, and it comes with a 15-day recovery period
-- (business_config.account_recovery_grace_days). Within it, an administrator can reactivate any account and a
-- customer who deactivated themselves can recover by signing in. After it, the purge deletes the account for good
-- while the shop keeps its bookings, payments and credit history. (Restores the purge turned off by 20270101000001.)

create or replace function public.reactivate_staff_account(p_account_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_grace integer;
begin
  select coalesce(account_recovery_grace_days, 15) into v_grace from public.business_config order by id limit 1;
  if exists (select 1 from public.profiles where id = p_account_id and is_active = false
               and deactivated_at < now() - make_interval(days => coalesce(v_grace, 15))) then
    raise exception 'The recovery period for this account has ended.' using errcode = 'check_violation';
  end if;
  update public.profiles
     set is_active = true, deactivated_at = null, staff_deactivated_at = null, staff_deactivation_reason = null,
         hired_at = case when upper(coalesce(role, '')) in ('STAFF', 'ADMIN') then current_date else hired_at end,
         updated_at = now()
   where id = p_account_id and is_active = false;
  if not found then raise exception 'This account was not deactivated.' using errcode = 'P0002'; end if;
  update auth.users set banned_until = null where id = p_account_id;
end;
$$;

create or replace function public.recover_account()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.profiles%rowtype; v_grace integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'Account not found'; end if;
  if upper(coalesce(v.role, '')) <> 'CUSTOMER' or v.staff_deactivated_at is not null then
    raise exception 'ADMIN_ONLY: this account can only be reactivated by an administrator.' using errcode = '42501';
  end if;
  if coalesce(v.is_active, true) then return jsonb_build_object('recovered', false, 'reason', 'ALREADY_ACTIVE'); end if;
  select coalesce(account_recovery_grace_days, 15) into v_grace from public.business_config order by id limit 1;
  if v.deactivated_at < now() - make_interval(days => coalesce(v_grace, 15)) then
    raise exception 'The recovery window for this account has expired (after % days).', v_grace using errcode = 'check_violation';
  end if;
  update public.profiles set is_active = true, deactivated_at = null, updated_at = now() where id = auth.uid();
  insert into public.audit_logs (action_type, details, actor_name, actor_role, actor_id, metadata)
  values ('ACCOUNT_RECOVERED', format('Account %s recovered within the %s-day recovery period.', coalesce(v.email, 'unknown'), v_grace),
          coalesce(v.full_name, v.email, 'User'), 'USER', auth.uid(),
          jsonb_build_object('user_id', auth.uid(), 'deactivated_at', v.deactivated_at, 'recovered_at', now()));
  return jsonb_build_object('recovered', true, 'user_id', auth.uid(), 'grace_days', v_grace, 'recovered_at', now());
end;
$$;

-- The purge, exactly as in 20261205000001.
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
