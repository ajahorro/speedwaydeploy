create or replace function public.admin_cancel_booking(
  p_booking_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_name text,
  p_actor_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_refund_amount numeric := 0;
  v_has_refund boolean := false;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'CANCELLATION_REASON_REQUIRED'
      using errcode = '22023';
  end if;

  if upper(coalesce(p_actor_role, '')) not in ('ADMIN', 'CUSTOMER') then
    raise exception 'CANCELLATION_ACTOR_NOT_ALLOWED'
      using errcode = '42501';
  end if;

  select *
    into v_booking
    from public.bookings
   where id = p_booking_id
   for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if upper(coalesce(p_actor_role, '')) = 'CUSTOMER'
     and v_booking.customer_id is distinct from p_actor_id then
    raise exception 'BOOKING_NOT_OWNED_BY_CUSTOMER'
      using errcode = '42501';
  end if;

  if lower(coalesce(v_booking.status::text, '')) in (
    'in_progress', 'ongoing', 'completed', 'released', 'cancelled'
  ) or exists (
    select 1
      from public.booking_vehicles
     where booking_id = p_booking_id
       and upper(coalesce(status::text, '')) in ('IN_PROGRESS', 'ONGOING', 'COMPLETED', 'RELEASED')
  ) then
    raise exception 'BOOKING_CANNOT_BE_CANCELLED'
      using errcode = '23514';
  end if;

  select greatest(
    0,
    coalesce((
      select sum(case
        when coalesce(detected_amount, 0) > 0 then detected_amount
        else amount
      end)
        from public.payments
       where booking_id = p_booking_id
         and upper(coalesce(status::text, '')) in ('PAID', 'FOR_VERIFICATION', 'REFUND_PENDING')
         and upper(coalesce(method::text, '')) <> 'SYSTEM_REFUND'
         and amount > 0
    ), 0)
    - coalesce((
      select sum(abs(amount))
        from public.payments
       where booking_id = p_booking_id
         and amount < 0
         and (
           upper(coalesce(method::text, '')) = 'SYSTEM_REFUND'
           or upper(coalesce(status::text, '')) = 'REFUNDED'
         )
    ), 0)
  )
    into v_refund_amount;

  v_has_refund := v_refund_amount > 0;

  update public.bookings
     set status = 'CANCELLED',
         staff_id = null,
         bay_id = null,
         cancellation_reason = btrim(p_reason),
         cancellation_type = case
           when upper(btrim(p_reason)) = 'NO-SHOW' then 'NO_SHOW'
           when upper(coalesce(p_actor_role, '')) = 'CUSTOMER' then 'CUSTOMER_REQUEST'
           else 'ADMIN_MANUAL'
         end,
         needs_attention = false,
         refund_status = case
           when v_has_refund then 'QUEUED'
           else refund_status
         end,
         updated_at = now()
   where id = p_booking_id;

  update public.booking_vehicles
     set status = 'CANCELLED'
   where booking_id = p_booking_id
     and upper(coalesce(status::text, '')) <> 'CANCELLED';

  update public.payments
     set status = 'REFUND_PENDING'
   where booking_id = p_booking_id
     and upper(coalesce(status::text, '')) in ('PAID', 'FOR_VERIFICATION');

  insert into public.audit_logs (
    booking_id,
    action_type,
    actor_name,
    actor_role,
    actor_id,
    details,
    metadata
  )
  values (
    p_booking_id,
    'BOOKING_CANCELLED',
    coalesce(nullif(btrim(p_actor_name), ''), 'ADMIN'),
    upper(coalesce(nullif(btrim(p_actor_role), ''), 'ADMIN')),
    p_actor_id,
    btrim(p_reason),
    jsonb_build_object(
      'previous_status', v_booking.status::text,
      'new_status', 'CANCELLED',
      'cancellation_reason', btrim(p_reason),
      'refund_status', case when v_has_refund then 'QUEUED' else null end,
      'refund_amount', round(v_refund_amount, 2)
    )
  );

  return jsonb_build_object(
    'success', true,
    'status', 'CANCELLED',
    'refund_status', case when v_has_refund then 'QUEUED' else null end,
    'refund_amount', round(v_refund_amount, 2)
  );
end;
$$;

revoke all on function public.admin_cancel_booking(uuid, text, uuid, text, text) from public;
revoke all on function public.admin_cancel_booking(uuid, text, uuid, text, text) from anon, authenticated;
grant execute on function public.admin_cancel_booking(uuid, text, uuid, text, text) to service_role;
