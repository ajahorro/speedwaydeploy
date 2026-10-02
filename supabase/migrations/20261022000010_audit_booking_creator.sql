create or replace function public.audit_booking_creator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text := 'System';
  v_actor_role text := 'SYSTEM';
begin
  if v_actor_id is not null then
    select
      coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Authenticated user'),
      upper(coalesce(nullif(btrim(p.role), ''), 'USER'))
    into v_actor_name, v_actor_role
    from public.profiles p
    where p.id = v_actor_id;
    if not found then
      v_actor_name := 'Authenticated user';
      v_actor_role := 'USER';
    end if;
  end if;

  insert into public.audit_logs (
    booking_id,
    action_type,
    details,
    actor_name,
    actor_role,
    actor_id,
    metadata,
    created_at
  ) values (
    new.id,
    'BOOKING_CREATED',
    case
      when v_actor_role = 'ADMIN' and coalesce(new.is_walk_in, false)
        then 'Admin created a walk-in booking.'
      when v_actor_role = 'ADMIN'
        then 'Admin created a booking.'
      else 'Booking created.'
    end,
    v_actor_name,
    v_actor_role,
    v_actor_id,
    jsonb_build_object(
      'source', 'booking_insert',
      'is_walk_in', coalesce(new.is_walk_in, false)
    ),
    now()
  );

  return new;
end;
$$;

drop trigger if exists trg_audit_booking_creator on public.bookings;
create trigger trg_audit_booking_creator
  after insert on public.bookings
  for each row
  execute function public.audit_booking_creator();
