create or replace function public.audit_booking_staff_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text := 'System';
  v_actor_role text := 'SYSTEM';
  v_previous_name text;
  v_new_name text;
  v_details text;
begin
  if tg_op = 'UPDATE' and old.staff_id is not distinct from new.staff_id then
    return new;
  end if;
  if tg_op = 'INSERT' and new.staff_id is null then
    return new;
  end if;

  if v_actor_id is not null then
    select
      coalesce(nullif(btrim(full_name), ''), nullif(btrim(email), ''), 'Authenticated user'),
      upper(coalesce(nullif(btrim(role::text), ''), 'USER'))
    into v_actor_name, v_actor_role
    from public.profiles
    where id = v_actor_id;
    if not found then
      v_actor_name := 'Authenticated user';
      v_actor_role := 'USER';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.staff_id is not null then
    select coalesce(nullif(btrim(full_name), ''), 'Staff account')
      into v_previous_name
      from public.profiles
      where id = old.staff_id;
    v_previous_name := coalesce(v_previous_name, 'Staff account');
  end if;

  if new.staff_id is not null then
    select coalesce(nullif(btrim(full_name), ''), 'Staff account')
      into v_new_name
      from public.profiles
      where id = new.staff_id;
    v_new_name := coalesce(v_new_name, 'Staff account');
  end if;

  if v_previous_name is null then
    v_details := format('Assigned %s to booking #%s.', v_new_name, left(new.id::text, 8));
  elsif v_new_name is null then
    v_details := format('Removed %s from booking #%s.', v_previous_name, left(new.id::text, 8));
  else
    v_details := format('Changed booking #%s assignment from %s to %s.', left(new.id::text, 8), v_previous_name, v_new_name);
  end if;

  insert into public.audit_logs (
    booking_id, action_type, details, actor_name, actor_role, actor_id, metadata, created_at
  ) values (
    new.id,
    'STAFF_ASSIGNMENT_CHANGED',
    v_details,
    v_actor_name,
    v_actor_role,
    v_actor_id,
    jsonb_strip_nulls(jsonb_build_object(
      'previous_staff_id', case when tg_op = 'UPDATE' then old.staff_id end,
      'previous_staff_name', v_previous_name,
      'new_staff_id', new.staff_id,
      'new_staff_name', v_new_name
    )),
    now()
  );

  return new;
end;
$$;

drop trigger if exists trg_audit_booking_staff_assignment_insert on public.bookings;
create trigger trg_audit_booking_staff_assignment_insert
  after insert on public.bookings
  for each row
  execute function public.audit_booking_staff_assignment();

drop trigger if exists trg_audit_booking_staff_assignment_update on public.bookings;
create trigger trg_audit_booking_staff_assignment_update
  after update of staff_id on public.bookings
  for each row
  execute function public.audit_booking_staff_assignment();

create or replace function public.audit_payment_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text := 'System';
  v_actor_role text := 'SYSTEM';
  v_old_status text;
  v_new_status text := upper(coalesce(new.status::text, ''));
  v_method text := upper(coalesce(new.method::text, ''));
  v_action text;
  v_details text;
begin
  if tg_op = 'UPDATE' then
    v_old_status := upper(coalesce(old.status::text, ''));
    if v_old_status = v_new_status then
      return new;
    end if;
  end if;

  if v_actor_id is not null then
    select
      coalesce(nullif(btrim(full_name), ''), nullif(btrim(email), ''), 'Authenticated user'),
      upper(coalesce(nullif(btrim(role::text), ''), 'USER'))
    into v_actor_name, v_actor_role
    from public.profiles
    where id = v_actor_id;
    if not found then
      v_actor_name := 'Authenticated user';
      v_actor_role := 'USER';
    end if;
  end if;

  if v_method = 'SYSTEM_REFUND' and v_new_status in ('REFUNDED', 'PAID') then
    v_action := 'REFUND_PROCESSED';
    v_details := format('Processed a refund of %s for booking #%s.', abs(new.amount), left(new.booking_id::text, 8));
  elsif v_new_status = 'PAID' and coalesce(new.manual_override, false) = false then
    v_action := 'PAYMENT_VERIFIED';
    v_details := format('Verified a payment of %s for booking #%s.', new.amount, left(new.booking_id::text, 8));
  elsif v_new_status = 'REJECTED' then
    v_action := 'PAYMENT_REJECTED';
    v_details := format('Rejected a payment for booking #%s.', left(new.booking_id::text, 8));
  elsif v_new_status = 'REFUND_PENDING' then
    v_action := 'PAYMENT_REFUND_QUEUED';
    v_details := format('Queued a payment refund for booking #%s.', left(new.booking_id::text, 8));
  elsif tg_op = 'INSERT' and v_new_status in ('PENDING', 'FOR_VERIFICATION') then
    v_action := 'PAYMENT_SUBMITTED';
    v_details := format('Submitted a payment of %s for booking #%s.', new.amount, left(new.booking_id::text, 8));
  end if;

  if v_action is null then
    return new;
  end if;

  insert into public.audit_logs (
    booking_id, action_type, details, actor_name, actor_role, actor_id, metadata, created_at
  ) values (
    new.booking_id,
    v_action,
    v_details,
    v_actor_name,
    v_actor_role,
    v_actor_id,
    jsonb_strip_nulls(jsonb_build_object(
      'payment_id', new.id,
      'amount', abs(new.amount),
      'payment_method', new.method::text,
      'previous_status', v_old_status,
      'new_status', v_new_status
    )),
    now()
  );

  return new;
end;
$$;

drop trigger if exists trg_audit_payment_change on public.payments;
create trigger trg_audit_payment_change
  after insert or update of status on public.payments
  for each row
  execute function public.audit_payment_change();
