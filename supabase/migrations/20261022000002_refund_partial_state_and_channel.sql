-- Track actual refund method/deduction and keep partially refunded bookings open.
alter table public.payments
  add column if not exists refund_deduction numeric not null default 0;

create or replace function public.process_booking_refund_v2(
  p_booking_id uuid,
  p_refund_amount numeric,
  p_refund_reason text,
  p_refund_reference text,
  p_refund_deduction numeric,
  p_refund_method text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_total numeric := 0;
  v_refunded_total numeric := 0;
  v_prior_deduction numeric := 0;
  v_deduction numeric := round(greatest(0, coalesce(p_refund_deduction, 0)), 2);
  v_refund_amount numeric := round(coalesce(p_refund_amount, 0), 2);
  v_refund_method text := upper(btrim(coalesce(p_refund_method, '')));
  v_remaining_refundable numeric := 0;
  v_full_refund boolean := false;
  v_now timestamptz := now();
  v_actor_id uuid := auth.uid();
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
  if nullif(btrim(coalesce(p_refund_reason, '')), '') is null then
    raise exception 'A refund reason is required';
  end if;
  if v_refund_method not in ('CASH', 'BANK TRANSFER') then
    raise exception 'Choose Cash or Bank Transfer as the refund method';
  end if;
  if v_refund_amount <= 0 then
    raise exception 'Refund amount must be greater than zero';
  end if;
  if exists (
    select 1 from public.payments
     where booking_id = p_booking_id
       and method = 'SYSTEM_REFUND'
       and reference_number = p_refund_reference
  ) then
    raise exception 'Refund reference % has already been processed', p_refund_reference;
  end if;

  perform 1 from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'Booking % not found', p_booking_id; end if;

  select coalesce(sum(amount), 0)
    into v_source_total
    from public.payments
   where booking_id = p_booking_id
     and amount > 0
     and status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and method <> 'SYSTEM_REFUND';

  select coalesce(sum(abs(amount)), 0), coalesce(max(refund_deduction), 0)
    into v_refunded_total, v_prior_deduction
    from public.payments
   where booking_id = p_booking_id
     and method = 'SYSTEM_REFUND'
     and amount < 0;

  if v_deduction < v_prior_deduction then
    raise exception 'The cancellation deduction cannot be reduced after a refund has been issued';
  end if;
  if v_deduction > v_source_total - v_refunded_total then
    raise exception 'Cancellation deduction cannot exceed the remaining paid amount';
  end if;

  v_remaining_refundable := greatest(0, v_source_total - v_refunded_total - v_deduction);
  if v_refund_amount > v_remaining_refundable then
    raise exception 'Refund amount cannot exceed the remaining refundable amount of %', v_remaining_refundable;
  end if;
  v_full_refund := v_refund_amount >= v_remaining_refundable;

  update public.bookings
     set status = 'cancelled',
         refund_status = case when v_full_refund then 'PROCESSED' else 'PROCESSING' end,
         refund_notes = p_refund_reason,
         updated_at = v_now
   where id = p_booking_id;

  if v_full_refund then
    update public.payments
       set status = 'REFUNDED',
           notes = concat_ws('|', notes, 'REFUND_PROCESSED_ON:' || v_now::date)
     where booking_id = p_booking_id
       and amount > 0
       and status in ('PAID', 'REFUND_PENDING');
  end if;

  insert into public.payments (
    booking_id, amount, status, method, reference_number,
    refund_reason, refund_method, refund_deduction, notes, refunded_at, refunded_by
  ) values (
    p_booking_id, -v_refund_amount, 'REFUNDED', 'SYSTEM_REFUND',
    p_refund_reference, p_refund_reason, v_refund_method, v_deduction,
    'REFUND_PROCESSED: ' || coalesce(p_refund_reason, 'No reason supplied'),
    v_now, v_actor_id
  );

  insert into public.audit_logs (
    booking_id, action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    p_booking_id,
    'ADMIN_PROCESSED_REFUND',
    format('Administrator refunded ₱%s by %s. Deduction: ₱%s. Ref: %s. Reason: %s.', v_refund_amount, v_refund_method, v_deduction, p_refund_reference, p_refund_reason),
    'Administrator', 'ADMIN', v_actor_id,
    jsonb_build_object(
      'amount', v_refund_amount,
      'deduction', v_deduction,
      'refund_method', v_refund_method,
      'reason', p_refund_reason,
      'refund_reference_id', p_refund_reference,
      'full_refund', v_full_refund
    )
  );

  insert into public.booking_messages (booking_id, sender_id, message, message_text, message_type, is_system, is_read)
  values (
    p_booking_id, v_actor_id,
    format('[SYSTEM] Refund of ₱%s by %s recorded. Deduction: ₱%s. Reason: %s', v_refund_amount, v_refund_method, v_deduction, p_refund_reason),
    format('[SYSTEM] Refund of ₱%s by %s recorded. Deduction: ₱%s. Reason: %s', v_refund_amount, v_refund_method, v_deduction, p_refund_reason),
    'system', true, true
  );

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'refund_amount', v_refund_amount,
    'refund_deduction', v_deduction,
    'refund_method', v_refund_method,
    'refund_reference', p_refund_reference,
    'full_refund', v_full_refund,
    'refund_status', case when v_full_refund then 'PROCESSED' else 'PROCESSING' end,
    'remaining_refund', greatest(0, v_remaining_refundable - v_refund_amount)
  );
end;
$$;

revoke all on function public.process_booking_refund_v2(uuid, numeric, text, text, numeric, text, uuid) from public, anon;
grant execute on function public.process_booking_refund_v2(uuid, numeric, text, text, numeric, text, uuid) to authenticated;

create or replace function public.process_overpayment_credit_refund_v2(
  p_booking_id uuid,
  p_refund_amount numeric,
  p_refund_reason text,
  p_refund_reference text,
  p_refund_method text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_method text := upper(btrim(coalesce(p_refund_method, '')));
  v_result jsonb;
  v_refund_status text;
  v_queued numeric := 0;
  v_refunded numeric := 0;
begin
  if v_method not in ('CASH', 'BANK TRANSFER') then
    raise exception 'Choose Cash or Bank Transfer as the refund method';
  end if;

  v_result := public.process_overpayment_credit_refund(
    p_booking_id, p_refund_amount, p_refund_reason, p_refund_reference, p_actor_id
  );

  update public.payments
     set refund_method = v_method
   where booking_id = p_booking_id
     and method = 'SYSTEM_REFUND'
     and reference_number = p_refund_reference
     and notes like 'OVERPAYMENT_CREDIT_REFUND:%';

  if not found then
    raise exception 'Could not record the refund method for reference %', p_refund_reference;
  end if;

  select refund_status into v_refund_status from public.bookings where id = p_booking_id;
  select coalesce(sum(-amount), 0)
    into v_queued
    from public.customer_credit_ledger
   where booking_id = p_booking_id
     and entry_type = 'REFUND_QUEUED';
  select coalesce(sum(abs(amount)), 0)
    into v_refunded
    from public.payments
   where booking_id = p_booking_id
     and method = 'SYSTEM_REFUND'
     and amount < 0
     and notes like 'OVERPAYMENT_CREDIT_REFUND:%';
  return v_result || jsonb_build_object(
    'refund_status', v_refund_status,
    'remaining_refund', greatest(0, v_queued - v_refunded)
  );
end;
$$;

revoke all on function public.process_overpayment_credit_refund_v2(uuid, numeric, text, text, text, uuid) from public, anon;
grant execute on function public.process_overpayment_credit_refund_v2(uuid, numeric, text, text, text, uuid) to authenticated;
