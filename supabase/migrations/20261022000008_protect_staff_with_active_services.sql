create or replace function public.staff_has_active_services(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.bookings as b
     where b.staff_id = p_staff_id
       and lower(coalesce(b.status, '')) in (
         'pending', 'pending_confirmation', 'scheduled', 'confirmed',
         'in_progress', 'ongoing', 'submitted'
       )
  )
  or exists (
    select 1
      from public.booking_vehicles as bv
      join public.bookings as b on b.id = bv.booking_id
     where b.staff_id = p_staff_id
       and upper(coalesce(bv.status, '')) in ('IN_PROGRESS', 'ONGOING')
       and lower(coalesce(b.status, '')) not in (
         'cancelled', 'completed', 'released', 'flagged_noshow', 'no_show'
       )
  );
$$;

comment on function public.staff_has_active_services(uuid) is
  'True while the staff member is assigned to a non-terminal booking or has a vehicle service currently in progress.';

revoke all on function public.staff_has_active_services(uuid) from public, anon, authenticated;
grant execute on function public.staff_has_active_services(uuid) to service_role;

create or replace function public.prevent_staff_revocation_during_service()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if upper(coalesce(old.role, '')) = 'STAFF' then
    if tg_op = 'DELETE' then
      if public.staff_has_active_services(old.id) then
        raise exception 'This staff account cannot be removed or deactivated while assigned to an active service. Reassign or complete the service first.'
          using errcode = 'check_violation';
      end if;
      return old;
    end if;

    if (
      upper(coalesce(new.role, '')) <> 'STAFF'
      or (coalesce(old.is_active, true) and not coalesce(new.is_active, true))
    ) and public.staff_has_active_services(old.id) then
      raise exception 'This staff account cannot be removed or deactivated while assigned to an active service. Reassign or complete the service first.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_prevent_staff_revocation_during_service on public.profiles;
create trigger profiles_prevent_staff_revocation_during_service
  before update of role, is_active or delete on public.profiles
  for each row
  execute function public.prevent_staff_revocation_during_service();

create or replace function public.revoke_staff_access(
  p_member_id uuid,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_admin_count integer;
  v_actor uuid := coalesce(p_actor_id, auth.uid());
begin
  if not public.is_admin() then
    raise exception 'Only administrators may revoke access';
  end if;

  select * into v_profile
    from public.profiles
   where id = p_member_id
   for update;
  if not found then
    raise exception 'Member not found';
  end if;

  if upper(coalesce(v_profile.role, '')) = 'STAFF'
     and public.staff_has_active_services(p_member_id) then
    raise exception 'This staff account cannot be deactivated while assigned to an active service. Reassign or complete the service first.'
      using errcode = 'check_violation';
  end if;

  if upper(coalesce(v_profile.role, '')) = 'ADMIN' then
    select count(*) into v_admin_count
      from public.profiles
     where upper(coalesce(role, '')) = 'ADMIN'
       and coalesce(is_active, true) = true;
    if v_admin_count <= 1 then
      raise exception 'This is the last remaining administrator account and cannot be revoked.'
        using errcode = 'check_violation';
    end if;
  end if;

  update public.profiles
     set role = 'CUSTOMER',
         updated_at = now()
   where id = p_member_id;

  insert into public.audit_logs (
    action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    'REVOKE_ACCESS',
    format('Account access revoked for %s. Role downgraded from %s to CUSTOMER.',
           coalesce(v_profile.full_name, v_profile.email), coalesce(v_profile.role, 'STAFF')),
    coalesce((select full_name from public.profiles where id = v_actor), 'Administrator'),
    'ADMIN', v_actor,
    jsonb_build_object('member_id', p_member_id, 'old_role', v_profile.role, 'new_role', 'CUSTOMER')
  );

  return jsonb_build_object(
    'member_id', p_member_id,
    'old_role', v_profile.role,
    'new_role', 'CUSTOMER',
    'role_version', coalesce(v_profile.role_version, 1) + 1
  );
end;
$$;

comment on function public.revoke_staff_access(uuid, uuid) is
  'Atomically demotes eligible staff/admin accounts, blocks revocation of staff assigned to active service, preserves a last-admin guard, and writes an audit row.';

revoke all on function public.revoke_staff_access(uuid, uuid) from public;
grant execute on function public.revoke_staff_access(uuid, uuid) to authenticated, service_role;
