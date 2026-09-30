-- Excess credit is only the settled amount above this booking's full price.

create or replace function public.booking_verified_paid(p_booking_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select greatest(0,
    coalesce(sum(
      case when coalesce(detected_amount, 0) > 0
        then detected_amount + greatest(0, coalesce(transfer_fee, 0))
        else amount
      end
    ) filter (
      where amount > 0
        and upper(coalesce(status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED')
        and upper(coalesce(method, '')) <> 'SYSTEM_REFUND'
    ), 0)
    - coalesce(sum(abs(amount)) filter (
      where amount < 0
        and (upper(coalesce(method, '')) = 'SYSTEM_REFUND'
             or upper(coalesce(status, '')) = 'REFUNDED')
    ), 0)
  )::numeric
    from public.payments
   where booking_id = p_booking_id;
$$;

create or replace function public.customer_booking_excess_credit(
  p_customer_id uuid,
  p_booking_id uuid
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is not null
     and v_caller <> p_customer_id
     and not public.is_admin() then
    raise exception 'A customer may only read their own booking credit'
      using errcode = 'insufficient_privilege';
  end if;

  return greatest(0, coalesce((
    select sum(amount)
      from public.customer_credit_ledger
     where customer_id = p_customer_id
       and booking_id = p_booking_id
  ), 0));
end;
$$;

create or replace function public.reconcile_booking_excess_credit(p_booking_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_booking_total numeric;
  v_booking_status text;
  v_refund_status text;
  v_target numeric;
  v_existing numeric;
  v_delta numeric;
  v_customer_balance numeric;
  v_entry_type text;
begin
  select customer_id, coalesce(total_amount, 0), lower(coalesce(status, '')),
         upper(coalesce(refund_status, ''))
    into v_customer_id, v_booking_total, v_booking_status, v_refund_status
    from public.bookings
   where id = p_booking_id
   for update;

  if not found or v_customer_id is null then return 0; end if;
  if v_booking_status = 'completed'
     or v_refund_status in ('QUEUED', 'PROCESSING', 'PROCESSED', 'EMAIL_PENDING') then
    return public.customer_booking_excess_credit(v_customer_id, p_booking_id);
  end if;

  perform pg_advisory_xact_lock(hashtext('speedway:credit:' || v_customer_id::text));
  v_target := greatest(0, round(public.booking_verified_paid(p_booking_id) - v_booking_total, 2));
  select coalesce(sum(amount), 0)
    into v_existing
    from public.customer_credit_ledger
   where customer_id = v_customer_id
     and booking_id = p_booking_id;
  v_delta := round(v_target - v_existing, 2);
  if v_delta = 0 then return v_target; end if;

  v_entry_type := case
    when v_delta < 0 then 'ABSORBED'
    when v_existing = 0 then 'EXCESS'
    else 'ADJUSTMENT'
  end;
  v_customer_balance := greatest(0, public.customer_excess_credit(v_customer_id) + v_delta);

  insert into public.customer_credit_ledger (
    customer_id, booking_id, entry_type, amount, balance_after, note
  ) values (
    v_customer_id, p_booking_id, v_entry_type, v_delta, v_customer_balance,
    case when v_delta > 0
      then 'Verified payment exceeds this booking total.'
      else 'Booking total/payment changed; excess credit reconciled.'
    end
  );
  return v_target;
end;
$$;

create or replace function public.reconcile_booking_credit_after_payment_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.reconcile_booking_excess_credit(old.booking_id);
    return old;
  end if;
  if tg_op = 'UPDATE' and old.booking_id is distinct from new.booking_id then
    perform public.reconcile_booking_excess_credit(old.booking_id);
  end if;
  perform public.reconcile_booking_excess_credit(new.booking_id);
  return new;
end;
$$;

create or replace function public.reconcile_booking_credit_after_total_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.reconcile_booking_excess_credit(new.id);
  return new;
end;
$$;

drop trigger if exists payments_reconcile_booking_credit on public.payments;
create trigger payments_reconcile_booking_credit
  after insert or update or delete on public.payments
  for each row execute function public.reconcile_booking_credit_after_payment_change();

drop trigger if exists bookings_reconcile_booking_credit on public.bookings;
create trigger bookings_reconcile_booking_credit
  after update of total_amount, customer_id on public.bookings
  for each row
  when (old.total_amount is distinct from new.total_amount
        or old.customer_id is distinct from new.customer_id)
  execute function public.reconcile_booking_credit_after_total_change();

create or replace function public.settle_overpayment_on_completion(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid;
  v_status text;
  v_refund_status text;
  v_excess numeric;
  v_balance numeric;
begin
  select customer_id, lower(coalesce(status, '')),
         upper(coalesce(refund_status, ''))
    into v_customer, v_status, v_refund_status
    from public.bookings
   where id = p_booking_id
   for update;

  if not found or v_customer is null then
    return jsonb_build_object('routed', 0, 'reason', 'booking not found');
  end if;
  if v_status <> 'completed' then
    raise exception 'Only a completed booking can route unused excess to refunds'
      using errcode = 'check_violation';
  end if;
  if v_refund_status in ('QUEUED', 'PROCESSING', 'PROCESSED', 'EMAIL_PENDING') then
    return jsonb_build_object('routed', 0, 'reason', 'refund already queued');
  end if;

  perform pg_advisory_xact_lock(hashtext('speedway:credit:' || v_customer::text));
  v_excess := public.customer_booking_excess_credit(v_customer, p_booking_id);
  if v_excess <= 0 then
    return jsonb_build_object('routed', 0, 'balance_after', public.customer_excess_credit(v_customer));
  end if;

  v_balance := greatest(0, public.customer_excess_credit(v_customer) - v_excess);
  insert into public.customer_credit_ledger (
    customer_id, booking_id, entry_type, amount, balance_after, note
  ) values (
    v_customer, p_booking_id, 'REFUND_QUEUED', -v_excess, v_balance,
    'Only this booking''s unused verified overpayment was routed to the Refund Hub.'
  );

  update public.bookings
     set refund_status = 'QUEUED',
         refund_notes = 'OVERPAYMENT_CREDIT:' || v_excess::text,
         updated_at = now()
   where id = p_booking_id;

  insert into public.audit_logs (
    booking_id, action_type, details, actor_name, actor_role, metadata
  ) values (
    p_booking_id, 'OVERPAYMENT_REFUND_QUEUED',
    'Unused verified excess of ' || v_excess || ' routed to the Refund Hub for this booking.',
    'System', 'SYSTEM', jsonb_build_object('excess_routed', v_excess, 'balance_after', v_balance)
  );

  return jsonb_build_object('routed', v_excess, 'balance_after', v_balance);
end;
$$;

create or replace function public.process_overpayment_credit_refund(
  p_booking_id uuid,
  p_refund_amount numeric,
  p_refund_reason text,
  p_refund_reference text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid;
  v_booking_status text;
  v_queued numeric;
  v_refunded numeric;
  v_amount numeric := round(p_refund_amount, 2);
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid() and upper(role) = 'ADMIN'
  ) then
    raise exception 'Administrator access is required to process refunds';
  end if;
  if p_actor_id is not null and p_actor_id <> auth.uid() then
    raise exception 'Refund actor does not match the authenticated administrator';
  end if;
  if v_amount <= 0 then raise exception 'Refund amount must be greater than zero'; end if;
  if exists (
    select 1 from public.payments
     where booking_id = p_booking_id
       and method = 'SYSTEM_REFUND'
       and reference_number = p_refund_reference
  ) then
    raise exception 'Refund reference % has already been processed', p_refund_reference;
  end if;

  select customer_id, lower(coalesce(status, ''))
    into v_customer, v_booking_status
    from public.bookings
   where id = p_booking_id
   for update;
  if not found then raise exception 'Booking % not found', p_booking_id; end if;
  if v_booking_status <> 'completed' then
    raise exception 'Overpayment-credit refunds must preserve a completed booking';
  end if;

  select greatest(0, coalesce(sum(-amount), 0))
    into v_queued
    from public.customer_credit_ledger
   where customer_id = v_customer
     and booking_id = p_booking_id
     and entry_type = 'REFUND_QUEUED';
  select coalesce(sum(abs(amount)), 0)
    into v_refunded
    from public.payments
   where booking_id = p_booking_id
     and method = 'SYSTEM_REFUND'
     and amount < 0
     and notes like 'OVERPAYMENT_CREDIT_REFUND:%';
  if v_amount > v_queued - v_refunded then
    raise exception 'Refund amount cannot exceed this booking''s queued excess of %', v_queued - v_refunded;
  end if;

  insert into public.payments (
    booking_id, amount, status, method, reference_number,
    refund_reason, notes, refunded_at, refunded_by
  ) values (
    p_booking_id, -v_amount, 'REFUNDED', 'SYSTEM_REFUND',
    p_refund_reference, p_refund_reason,
    'OVERPAYMENT_CREDIT_REFUND: ' || coalesce(p_refund_reason, 'No reason supplied'),
    now(), p_actor_id
  );

  update public.bookings
     set refund_status = case when v_amount >= v_queued - v_refunded then 'PROCESSED' else 'QUEUED' end,
         refund_notes = p_refund_reason,
         updated_at = now()
   where id = p_booking_id;

  insert into public.audit_logs (
    booking_id, action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    p_booking_id, 'OVERPAYMENT_REFUND_PROCESSED',
    'Refunded ' || v_amount || ' of this booking''s verified excess credit.',
    'Admin', 'ADMIN', p_actor_id,
    jsonb_build_object('refund_amount', v_amount, 'queued_amount', v_queued)
  );

  return jsonb_build_object('refund_amount', v_amount, 'booking_status_preserved', true);
end;
$$;

-- Client code must not pre-spend or invent ledger credits.
revoke all on function public.record_excess_credit(uuid, uuid, numeric, text) from public, anon, authenticated;
revoke all on function public.apply_service_downpayment(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function public.process_overpayment_credit_refund(uuid, numeric, text, text, uuid) from public, anon, authenticated;
revoke all on function public.settle_overpayment_on_completion(uuid) from public, anon, authenticated;
revoke all on function public.customer_booking_excess_credit(uuid, uuid) from public, anon;
grant execute on function public.customer_booking_excess_credit(uuid, uuid) to authenticated, service_role;
grant execute on function public.settle_overpayment_on_completion(uuid) to service_role;
grant execute on function public.process_overpayment_credit_refund(uuid, numeric, text, text, uuid) to authenticated;

revoke all on function public.booking_verified_paid(uuid) from public, anon, authenticated;
revoke all on function public.reconcile_booking_excess_credit(uuid) from public, anon, authenticated;
revoke all on function public.reconcile_booking_credit_after_payment_change() from public, anon, authenticated;
revoke all on function public.reconcile_booking_credit_after_total_change() from public, anon, authenticated;

-- Repair historic premature credits and seed only excess above each booking total.
do $backfill$
declare
  v_booking record;
begin
  for v_booking in
    select id
      from public.bookings
     where id in (select booking_id from public.payments where booking_id is not null)
        or id in (select booking_id from public.customer_credit_ledger where booking_id is not null)
  loop
    perform public.reconcile_booking_excess_credit(v_booking.id);
  end loop;
end;
$backfill$;