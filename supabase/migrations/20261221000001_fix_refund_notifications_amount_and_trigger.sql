-- Migration: 20261221000001_fix_refund_notifications_amount_and_trigger.sql
-- Fixes the 0.00 refund notification issue by:
-- 1. Ensuring notify_admins_financial_event() never outputs 0.00 refund notifications,
--    accurately resolves the refund amount from SYSTEM_REFUND, and handles payment-level refund triggers.
-- 2. Ordering process_booking_refund_v2() so payments are updated/inserted before bookings.refund_status
--    is updated to 'PROCESSED'.
-- 3. Correcting historical notifications that were recorded with "PHP 0.00".

-- ── 1. Recreate notify_admins_financial_event() with accurate amounts & guards ──
create or replace function public.notify_admins_financial_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_ref text;
  v_amount numeric;
  v_refund_status text;
  v_title text;
  v_message text;
  v_type text;
begin
  if tg_table_name = 'payments' then
    select left(id::text, 8), refund_status into v_booking_ref, v_refund_status
    from public.bookings
    where id = new.booking_id;

    if new.status = 'FOR_VERIFICATION'
       and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.status is distinct from new.status)) then
      v_title := 'Payment Verification Required';
      v_message := 'Payment of PHP ' || to_char(coalesce(new.amount, 0), 'FM999,999,990.00')
        || ' is awaiting verification for booking #' || coalesce(v_booking_ref, left(new.booking_id::text, 8)) || '.';
      v_type := 'PAYMENT_SUBMITTED';
    elsif new.status = 'REFUND_PENDING'
          and tg_op = 'UPDATE'
          and old.status is distinct from new.status
          and coalesce(v_refund_status, '') <> 'PENDING' then
      v_amount := abs(coalesce(new.amount, 0));
      if v_amount <= 0 then
        return new;
      end if;
      v_title := 'Refund Required';
      v_message := 'A refund of PHP ' || to_char(v_amount, 'FM999,999,990.00')
        || ' is ready to be processed for booking #' || coalesce(v_booking_ref, left(new.booking_id::text, 8)) || '.';
      v_type := 'REFUND_PENDING';
    elsif upper(coalesce(new.method::text, '')) = 'SYSTEM_REFUND'
          and upper(coalesce(new.status::text, '')) = 'REFUNDED'
          and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.status is distinct from new.status)) then
      v_amount := abs(coalesce(new.amount, 0));
      if v_amount <= 0 then
        return new;
      end if;
      v_title := 'Refund Processed';
      v_message := 'Refund of PHP ' || to_char(v_amount, 'FM999,999,990.00')
        || ' was processed for booking #' || coalesce(v_booking_ref, left(new.booking_id::text, 8)) || '.';
      v_type := 'REFUND_PROCESSED';
    else
      return new;
    end if;

    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    select p.id, v_title, v_message, v_type, '/admin/bookings/' || new.booking_id, new.booking_id, new.booking_id, false
    from public.profiles p
    where upper(p.role) = 'ADMIN'
      and coalesce(p.is_active, true) = true
      and not exists (
        select 1 from public.notifications n
        where n.user_id = p.id
          and n.booking_id = new.booking_id
          and n.notification_type = v_type
          and n.created_at >= now() - interval '1 minute'
      );

  elsif tg_table_name = 'bookings'
        and new.refund_status in ('PENDING', 'PROCESSED')
        and tg_op = 'UPDATE'
        and old.refund_status is distinct from new.refund_status then

    if new.refund_status = 'PENDING' then
      select coalesce(sum(amount), 0) into v_amount
      from public.payments
      where booking_id = new.id and status in ('PAID', 'REFUND_PENDING');

      if v_amount <= 0 then
        return new;
      end if;

      v_title := 'Refund Required';
      v_message := 'A refund of PHP ' || to_char(v_amount, 'FM999,999,990.00')
        || ' is ready to be processed for booking #' || left(new.id::text, 8) || '.';
      v_type := 'REFUND_PENDING';
    else
      -- PROCESSED: check SYSTEM_REFUND ledger entries first
      select abs(amount) into v_amount
      from public.payments
      where booking_id = new.id and method = 'SYSTEM_REFUND'
      order by created_at desc
      limit 1;

      if v_amount is null or v_amount <= 0 then
        select coalesce(sum(amount), 0) into v_amount
        from public.payments
        where booking_id = new.id and status = 'REFUNDED' and amount > 0;
      end if;

      -- Safety guard: NEVER send 0.00 refund notification
      if v_amount is null or v_amount <= 0 then
        return new;
      end if;

      v_title := 'Refund Processed';
      v_message := 'Refund of PHP ' || to_char(v_amount, 'FM999,999,990.00')
        || ' was processed for booking #' || left(new.id::text, 8) || '.';
      v_type := 'REFUND_PROCESSED';
    end if;

    insert into public.notifications (user_id, title, message, notification_type, action_url, booking_id, entity_id, is_read)
    select p.id, v_title, v_message, v_type, '/admin/bookings/' || new.id, new.id, new.id, false
    from public.profiles p
    where upper(p.role) = 'ADMIN'
      and coalesce(p.is_active, true) = true
      and not exists (
        select 1 from public.notifications n
        where n.user_id = p.id
          and n.booking_id = new.id
          and n.notification_type = v_type
          and n.created_at >= now() - interval '1 minute'
      );
  end if;

  return new;
end;
$$;

-- ── 2. Update process_booking_refund_v2 to write payments BEFORE updating bookings ──
create or replace function public.process_booking_refund_v2(
  p_booking_id uuid,
  p_refund_amount numeric,
  p_refund_reason text,
  p_refund_reference text,
  p_refund_deduction numeric default 0,
  p_refund_method text default 'CASH',
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
  v_remaining_refundable numeric := 0;
  v_deduction numeric := coalesce(p_refund_deduction, 0);
  v_refund_amount numeric := coalesce(p_refund_amount, 0);
  v_refund_method text := upper(coalesce(nullif(btrim(p_refund_method), ''), 'CASH'));
  v_full_refund boolean := false;
  v_now timestamptz := now();
  v_booking public.bookings%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  if p_refund_reference is null or btrim(p_refund_reference) = '' then
    raise exception 'Refund reference is required';
  end if;

  if exists (
    select 1
      from public.payments
     where reference_number = p_refund_reference
       and booking_id <> p_booking_id
  ) then
    raise exception 'Refund reference % has already been used on another booking', p_refund_reference;
  end if;

  if v_refund_method not in ('CASH', 'BANK TRANSFER') then
    raise exception 'Refund method must be CASH or BANK TRANSFER';
  end if;

  select *
    into v_booking
    from public.bookings
   where id = p_booking_id
   for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id;
  end if;

  if v_deduction < 0 then
    raise exception 'Cancellation deduction cannot be negative';
  end if;

  if v_refund_amount <= 0 then
    raise exception 'Refund amount must be greater than zero';
  end if;

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

  -- 1. Update source payments to REFUNDED first
  if v_full_refund then
    update public.payments
       set status = 'REFUNDED',
           notes = concat_ws('|', notes, 'REFUND_PROCESSED_ON:' || v_now::date)
     where booking_id = p_booking_id
       and amount > 0
       and status in ('PAID', 'REFUND_PENDING');
  end if;

  -- 2. Insert the SYSTEM_REFUND entry in payments ledger
  insert into public.payments (
    booking_id, amount, status, method, reference_number,
    refund_reason, refund_method, refund_deduction, notes, refunded_at, refunded_by
  ) values (
    p_booking_id, -v_refund_amount, 'REFUNDED', 'SYSTEM_REFUND',
    p_refund_reference, p_refund_reason, v_refund_method, v_deduction,
    'REFUND_PROCESSED: ' || coalesce(p_refund_reason, 'No reason supplied'),
    v_now, v_actor_id
  );

  -- 3. Update the booking status (triggers will now see the refund payment in payments ledger)
  update public.bookings
     set status = 'cancelled',
         refund_status = case when v_full_refund then 'PROCESSED' else 'PROCESSING' end,
         refund_notes = p_refund_reason,
         updated_at = v_now
   where id = p_booking_id;

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

-- ── 3. Backfill/Correct existing notifications with 0.00 refund amounts ─────────
update public.notifications n
set message = 'Refund of PHP ' || to_char(p.refund_amount, 'FM999,999,990.00') || ' was processed for booking #' || left(n.booking_id::text, 8) || '.'
from (
  select booking_id, abs(amount) as refund_amount
  from public.payments
  where method = 'SYSTEM_REFUND'
) p
where n.booking_id = p.booking_id
  and n.message ilike '%PHP 0.00%';
