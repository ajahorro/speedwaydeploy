-- A customer who has paid more than their booking costs can ask for the excess back while the booking is still
-- going ahead (not started, in progress, or completed), or use it to add a service.
--
--   * request_excess_refund(booking): the customer of the booking (or an administrator) queues the booking's unused
--     excess for the Refund Hub. The booking itself is not touched.
--   * The administrator's excess refund no longer insists on a completed booking: any booking that is not cancelled or
--     a no-show can have its queued excess refunded, and the booking keeps its status.
--   * A refund's method is told to the proof rule (cash needs no proof picture) also for excess refunds, whose method
--     is written after the row is inserted.

-- 1. admin excess refund: any booking still going ahead
do $patch$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.process_overpayment_credit_refund(uuid,numeric,text,text,uuid)'::regprocedure) into v_def;
  v_new := regexp_replace(v_def,
    'if v_booking_status <> ''completed'' then\s+raise exception ''Overpayment-credit refunds must preserve a completed booking'';\s+end if;',
    'if v_booking_status in (''cancelled'', ''flagged_noshow'', ''no_show'', ''released'') then raise exception ''A cancelled or no-show booking is refunded from everything paid, not as an excess refund''; end if;');
  if v_new = v_def then raise exception 'process_overpayment_credit_refund layout changed; patch not applied'; end if;
  execute v_new;

  select pg_get_functiondef('public.process_overpayment_credit_refund_v2(uuid,numeric,text,text,text,uuid)'::regprocedure) into v_def;
  v_new := replace(v_def,
    E'  v_result := public.process_overpayment_credit_refund(',
    E'  perform set_config(''app.refund_method'', v_method, true);\n  v_result := public.process_overpayment_credit_refund(');
  if v_new = v_def then raise exception 'process_overpayment_credit_refund_v2 layout changed; patch not applied'; end if;
  execute v_new;
end
$patch$;

-- 2. the proof rule knows the method of an excess refund too
create or replace function public.require_refund_proof()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_method text := upper(btrim(coalesce(nullif(new.refund_method, ''), current_setting('app.refund_method', true), '')));
begin
  if new.method = 'SYSTEM_REFUND' and coalesce(new.amount, 0) < 0 and v_method <> 'CASH' then
    if not exists (
      select 1 from public.refund_proofs rp
       where rp.booking_id = new.booking_id and rp.refund_reference = new.reference_number
    ) then
      raise exception 'REFUND_PROOF_REQUIRED: upload the proof of refund before the refund is processed.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- 3. the customer asks for their excess back
create or replace function public.request_excess_refund(p_booking_id uuid)
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
  v_ref text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select customer_id, lower(coalesce(status, '')), upper(coalesce(refund_status, ''))
    into v_customer, v_status, v_refund_status
    from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'Booking not found.'; end if;
  if v_customer is distinct from auth.uid() and not public.is_admin() then
    raise exception 'You can only ask for a refund on your own booking.' using errcode = '42501';
  end if;
  if v_status in ('cancelled', 'flagged_noshow', 'no_show', 'released') then
    raise exception 'This booking is cancelled. Its refund is handled by the shop.';
  end if;
  if v_refund_status in ('QUEUED', 'PROCESSING', 'EMAIL_PENDING') then
    return jsonb_build_object('routed', 0, 'reason', 'A refund is already requested for this booking.');
  end if;

  perform pg_advisory_xact_lock(hashtext('speedway:credit:' || v_customer::text));
  v_excess := public.customer_booking_excess_credit(v_customer, p_booking_id);
  if v_excess <= 0 then
    return jsonb_build_object('routed', 0, 'reason', 'There is no excess payment on this booking.');
  end if;

  v_balance := greatest(0, public.customer_excess_credit(v_customer) - v_excess);
  insert into public.customer_credit_ledger (customer_id, booking_id, entry_type, amount, balance_after, note)
  values (v_customer, p_booking_id, 'REFUND_QUEUED', -v_excess, v_balance, 'The customer asked for the excess of this booking to be refunded.');

  update public.bookings
     set refund_status = 'QUEUED', refund_notes = 'OVERPAYMENT_CREDIT:' || v_excess::text, updated_at = now()
   where id = p_booking_id;

  v_ref := upper(left(p_booking_id::text, 8));
  insert into public.audit_logs (booking_id, action_type, details, actor_name, actor_role, actor_id, metadata)
  values (p_booking_id, 'OVERPAYMENT_REFUND_REQUESTED',
          'The customer asked for the excess payment of ' || v_excess || ' to be refunded.',
          'Customer', 'CUSTOMER', auth.uid(), jsonb_build_object('excess', v_excess));

  insert into public.notifications (user_id, title, message, notification_type, action_url, is_read, booking_id)
  select p.id, 'Excess refund requested',
         'A customer asked for an excess of ₱' || v_excess || ' on booking #' || v_ref || ' to be refunded.',
         'EXCESS_REFUND_REQUESTED', '/admin/refunds', false, p_booking_id
    from public.profiles p
   where upper(coalesce(p.role, '')) = 'ADMIN' and coalesce(p.is_active, true);

  return jsonb_build_object('routed', v_excess, 'balance_after', v_balance);
end;
$$;

revoke all on function public.request_excess_refund(uuid) from public, anon;
grant execute on function public.request_excess_refund(uuid) to authenticated;
