-- ============================================================================
-- Fix: process_booking_refund() aborts on a NOT NULL booking_messages.sender_id
-- ============================================================================
-- Symptom: clicking "Mark as Refunded" in the Refund Hub returned HTTP 400
--   null value in column "sender_id" of relation "booking_messages"
--   violates not-null constraint
-- so the whole refund transaction rolled back and the admin saw a generic
-- "Failed to load refund requests" / toast error in the console.
--
-- Cause: the RPC wrote its audit chat line as
--   insert into booking_messages (booking_id, sender_id, message, message_type)
--   values (p_booking_id, null, ...)
-- but the live booking_messages.sender_id is NOT NULL (FK -> profiles). The
-- message_type='system' rows are deliberately filtered out of the visible chat
-- thread (BookingChat/ChatContext skip message_type='system'), so these rows are
-- audit breadcrumbs — but they still need a real sender row.
--
-- Fix: attribute the system line to the acting administrator (auth.uid() is
-- already proven to be an ADMIN earlier in the function) and set is_system=true,
-- keeping message_type='system' so the chat thread still hides it.
-- ============================================================================

create or replace function public.process_booking_refund(
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
  v_source_total numeric := 0;
  v_refunded_total numeric := 0;
  v_remaining_refundable numeric := 0;
  v_refund_amount numeric := round(p_refund_amount, 2);
  v_full_refund boolean;
  v_now timestamptz := now();
  v_actor_id uuid := auth.uid();
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and upper(role) = 'ADMIN'
  ) then
    raise exception 'Administrator access is required to process refunds';
  end if;

  if p_actor_id is not null and p_actor_id <> auth.uid() then
    raise exception 'Refund actor does not match the authenticated administrator';
  end if;

  if exists (
    select 1 from public.payments
     where booking_id = p_booking_id
       and method = 'SYSTEM_REFUND'
       and reference_number = p_refund_reference
  ) then
    raise exception 'Refund reference % has already been processed', p_refund_reference;
  end if;

  if v_refund_amount <= 0 then
    raise exception 'Refund amount must be greater than zero';
  end if;

  -- Serialize refunds for this booking before calculating its remaining balance.
  perform 1
    from public.bookings
   where id = p_booking_id
   for update;

  if not found then
    raise exception 'Booking % not found', p_booking_id;
  end if;

  select coalesce(sum(amount), 0)
    into v_source_total
    from public.payments
   where booking_id = p_booking_id
     and amount > 0
     and status in ('PAID', 'REFUND_PENDING');

  select coalesce(sum(abs(amount)), 0)
    into v_refunded_total
    from public.payments
   where booking_id = p_booking_id
     and method = 'SYSTEM_REFUND'
     and amount < 0;

  v_remaining_refundable := v_source_total - v_refunded_total;

  if v_remaining_refundable <= 0 then
    raise exception 'No refundable payment found for booking %', p_booking_id;
  end if;

  if v_refund_amount > v_remaining_refundable then
    raise exception 'Refund amount cannot exceed remaining refundable amount of %', v_remaining_refundable;
  end if;

  v_full_refund := v_refund_amount >= v_remaining_refundable;

  update public.bookings
     set status = 'cancelled',
         refund_status = 'PROCESSED',
         refund_notes = p_refund_reason,
         updated_at = v_now
   where id = p_booking_id;

  if not found then
    raise exception 'Booking % not found', p_booking_id;
  end if;

  -- Full refunds close the source payments. Partial refunds leave them PAID
  -- (or REFUND_PENDING) and are represented only by the negative ledger row.
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
    refund_reason, notes, refunded_at
  ) values (
    p_booking_id, -v_refund_amount, 'REFUNDED', 'SYSTEM_REFUND',
    p_refund_reference, p_refund_reason,
    'REFUND_PROCESSED: ' || coalesce(p_refund_reason, 'No reason supplied'),
    v_now
  );

  insert into public.audit_logs (
    booking_id, action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    p_booking_id,
    'ADMIN_PROCESSED_REFUND',
    format('Administrator processed refund of ₱%s. Ref: %s. Reason: %s.', v_refund_amount, p_refund_reference, p_refund_reason),
    'Administrator', 'ADMIN', v_actor_id,
    jsonb_build_object('amount', v_refund_amount, 'reason', p_refund_reason, 'refund_reference_id', p_refund_reference, 'full_refund', v_full_refund)
  );

  -- Audit breadcrumb in the booking thread. sender_id is NOT NULL, so the
  -- acting admin is the attributable author; message_type='system' keeps the
  -- line hidden from the customer/staff conversation view.
  insert into public.booking_messages (booking_id, sender_id, message, message_text, message_type, is_system, is_read)
  values (
    p_booking_id,
    v_actor_id,
    format('[SYSTEM] Refund Processed. Amount: ₱%s. Reason: %s', v_refund_amount, p_refund_reason),
    format('[SYSTEM] Refund Processed. Amount: ₱%s. Reason: %s', v_refund_amount, p_refund_reason),
    'system',
    true,
    true
  );

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'refund_amount', v_refund_amount,
    'refund_reference', p_refund_reference,
    'full_refund', v_full_refund,
    'refund_status', 'PROCESSED'
  );
end;
$$;

revoke all on function public.process_booking_refund(uuid, numeric, text, text, uuid) from public;
grant execute on function public.process_booking_refund(uuid, numeric, text, text, uuid) to authenticated;