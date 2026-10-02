create or replace function public.prevent_staff_revocation_during_service()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if upper(coalesce(old.role, '')) = 'STAFF'
       and public.staff_has_active_services(old.id) then
      raise exception 'This staff account cannot be removed or deactivated while assigned to an active service. Reassign or complete the service first.'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if upper(coalesce(old.role, '')) = 'STAFF'
     and (
       upper(coalesce(new.role, '')) <> 'STAFF'
       or (coalesce(old.is_active, true) and not coalesce(new.is_active, true))
     )
     and public.staff_has_active_services(old.id) then
    raise exception 'This staff account cannot be removed or deactivated while assigned to an active service. Reassign or complete the service first.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
