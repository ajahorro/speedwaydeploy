-- Accounts are never deleted. Removing an account only deactivates it; it stays deactivated until reactivated.
-- An account deactivated by an administrator (any role) is marked with staff_deactivated_at, cannot sign in,
-- and only an administrator can bring it back. A customer who deactivated their own account can sign back in
-- at any time to recover it.

create or replace function public.deactivate_staff_account(p_account_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set is_active = false, deactivated_at = now(), staff_deactivated_at = now(),
         staff_deactivation_reason = coalesce(nullif(btrim(p_reason), ''), 'Deactivated by an administrator.'),
         updated_at = now()
   where id = p_account_id;
  if not found then raise exception 'Account not found.' using errcode = 'P0002'; end if;
  update auth.users set banned_until = now() + interval '100 years' where id = p_account_id;
end;
$$;

create or replace function public.reactivate_staff_account(p_account_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
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
declare v public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'Account not found'; end if;
  if upper(coalesce(v.role, '')) <> 'CUSTOMER' or v.staff_deactivated_at is not null then
    raise exception 'ADMIN_ONLY: this account can only be reactivated by an administrator.' using errcode = '42501';
  end if;
  if coalesce(v.is_active, true) then return jsonb_build_object('recovered', false, 'reason', 'ALREADY_ACTIVE'); end if;
  update public.profiles set is_active = true, deactivated_at = null, updated_at = now() where id = auth.uid();
  insert into public.audit_logs (action_type, details, actor_name, actor_role, actor_id, metadata)
  values ('ACCOUNT_RECOVERED', format('Account %s was reactivated by its owner.', coalesce(v.email, 'unknown')),
          coalesce(v.full_name, v.email, 'User'), 'USER', auth.uid(),
          jsonb_build_object('user_id', auth.uid(), 'deactivated_at', v.deactivated_at, 'recovered_at', now()));
  return jsonb_build_object('recovered', true, 'user_id', auth.uid(), 'recovered_at', now());
end;
$$;

-- No account is ever purged.
create or replace function public.purge_deactivated_accounts()
returns integer language sql security definer set search_path = public as $$ select 0 $$;

revoke all on function public.deactivate_staff_account(uuid, text) from public, anon, authenticated;
revoke all on function public.reactivate_staff_account(uuid) from public, anon, authenticated;
revoke all on function public.purge_deactivated_accounts() from public, anon, authenticated;
grant execute on function public.deactivate_staff_account(uuid, text) to service_role;
grant execute on function public.reactivate_staff_account(uuid) to service_role;
grant execute on function public.purge_deactivated_accounts() to service_role;
