-- ============================================================================
-- 4.2 "To be received" (admin only).
--
-- A receivable is a payments row with method RECEIVABLE and status PENDING. It
-- is never money received: the ledger ignores it for settled/pending money, so
-- it already reads as an unpaid balance. The only things it changes:
--   * booking_ledger_v.deferred_amount  (appended) = the deferred part of the
--     still-outstanding balance; it shrinks as real payments arrive.
--   * downpayment_met also accepts deferred_amount, because the admin
--     deliberately allowed work to start.
-- The amount is derived from the booking's outstanding balance. Nobody types it.
-- ============================================================================

create or replace view public.booking_ledger_v
with (security_invoker = true)
as
select
  b.id as booking_id,
  b.customer_id,
  b.staff_id,
  b.status as booking_status,
  b.start_datetime,
  coalesce(
    nullif(trim(coalesce(prof.full_name, '')), ''),
    nullif(trim(coalesce(b.customer_name, '')), ''),
    nullif(trim(concat_ws(' ', b.guest_first_name, b.guest_last_name)), ''),
    nullif(trim(coalesce(b.guest_name, '')), ''),
    'Walk-in'
  ) as customer_name,
  round(coalesce(b.total_amount, 0), 2) as original_amount,
  round(e.expected, 2) as expected_amount,
  s.cancelled_no_fee,
  round(a.settled, 2) as settled_amount,
  round(a.refunded, 2) as refunded_amount,
  round(s.net_settled, 2) as net_settled,
  -- Money ACCEPTED toward the service (PAID only, minus refunds). Rejected
  -- payments awaiting refund (REFUND_PENDING) are held, not accepted, so they
  -- count in net_settled but never toward the work-start downpayment gate.
  round(s.verified_paid, 2) as verified_paid,
  round(greatest(0, e.expected - (a.settled - a.refunded)), 2) as outstanding_amount,
  round(greatest(0, (a.settled - a.refunded) - e.expected), 2) as excess_amount,
  round(a.pending, 2) as pending_verification,
  round(a.pending_detected, 2) as pending_ocr_detected,
  round(a.pending, 2) as pending_declared,
  case when a.pending_detected > 0 then round(a.pending - a.pending_detected, 2) else 0 end as ocr_variance,
  round(a.pending_fee, 2) as ocr_transfer_fee,
  round(a.settled_fee, 2) as settled_transfer_fee,
  round(a.pending_credit_applied, 2) as credit_applied,
  a.ocr_status,
  a.ocr_reference,
  a.pending > 0 as has_pending_verification,
  a.pending_detected > 0 as has_ocr_data,
  (a.pending_detected > 0 and abs(a.pending - a.pending_detected) > 0.01) as has_discrepancy,
  (s.net_settled >= e.expected and e.expected > 0) as fully_settled,
  d.required as required_downpayment,
  d.rate as downpayment_rate,
  ((s.verified_paid + least(rc.deferred, greatest(0, e.expected - (a.settled - a.refunded)))) >= d.required) as downpayment_met,
  -- Work-completion gates use ACCEPTED money (verified_paid), not held funds.
  round(greatest(0, e.expected - s.verified_paid), 2) as service_balance_due,
  (s.verified_paid >= e.expected) as service_paid_in_full,
  case
    when s.cancelled_no_fee then 'void'
    when a.refunded > 0 and s.net_settled <= 0 then 'refunded'
    when (a.settled - a.refunded) - e.expected > 0.005 and e.expected > 0 then 'overpaid'
    when s.net_settled >= e.expected and e.expected > 0 then 'paid'
    when a.refunded > 0 and s.net_settled > 0 then 'partially_refunded'
    when s.net_settled > 0 then 'partial'
    when a.pending > 0 then 'pending'
    else 'unpaid'
  end as paid_status,
  a.settled_count as settled_payment_count,
  a.last_settled_at,
  -- Customer-facing "as submitted" figures (settled + awaiting verification),
  -- using the same per-payment rule. Transfer fees are shown, never credited.
  round(a.pending_net, 2) as pending_net_received,
  round(a.settled + a.settled_fee, 2) as settled_gross_paid,
  round(a.accepted + a.accepted_fee, 2) as verified_gross_paid,
  round(s.net_settled + a.pending_net, 2) as submitted_net_received,
  round(a.settled + a.settled_fee + a.pending_net + a.pending_fee, 2) as submitted_gross_paid,
  round(a.settled_fee + a.pending_fee, 2) as submitted_transfer_fee,
  round(greatest(0, e.expected - (s.net_settled + a.pending_net)), 2) as submitted_balance_due,
  round(greatest(0, (s.net_settled + a.pending_net) - e.expected), 2) as submitted_excess,
  -- Admin "to be received": NOT money received. It is the part of the unpaid balance the
  -- admin deliberately deferred; it shrinks automatically as real payments arrive.
  round(least(rc.deferred, greatest(0, e.expected - (a.settled - a.refunded))), 2) as deferred_amount
from public.bookings b
left join public.profiles prof on prof.id = b.customer_id
cross join lateral (
  select coalesce(sum(p.amount), 0) as deferred
    from public.payments p
   where p.booking_id = b.id
     and upper(coalesce(p.method, '')) = 'RECEIVABLE'
     and upper(coalesce(p.status, '')) = 'PENDING'
) rc
cross join (select public.shop_downpayment_policy() as pol) policy
cross join lateral (
  select
    coalesce(sum(l.net_received) filter (where l.is_settled_credit), 0) as settled,
    coalesce(sum(l.net_received) filter (where l.is_settled_credit and l.status = 'PAID'), 0) as accepted,
    coalesce(sum(abs(l.amount)) filter (where l.is_refund), 0) as refunded,
    coalesce(sum(l.amount) filter (where l.is_pending), 0) as pending,
    coalesce(sum(coalesce(l.detected_amount, 0)) filter (where l.is_pending), 0) as pending_detected,
    coalesce(sum(l.transfer_fee) filter (where l.is_pending), 0) as pending_fee,
    coalesce(sum(l.transfer_fee) filter (where l.is_settled_credit), 0) as settled_fee,
    coalesce(sum(l.credit_applied) filter (where l.is_pending), 0) as pending_credit_applied,
    coalesce(sum(l.net_received) filter (where l.is_pending), 0) as pending_net,
    coalesce(sum(l.transfer_fee) filter (where l.is_settled_credit and l.status = 'PAID'), 0) as accepted_fee,
    count(*) filter (where l.is_settled_credit) as settled_count,
    max(l.recognized_at) filter (where l.is_settled_credit) as last_settled_at,
    (array_agg(l.status order by l.created_at desc) filter (where l.is_pending))[1] as ocr_status,
    (array_agg(l.reference order by l.created_at desc) filter (where l.is_pending))[1] as ocr_reference
  from (
    select
      p.amount,
      p.detected_amount,
      coalesce(p.transfer_fee, 0) as transfer_fee,
      coalesce(p.credit_applied, 0) as credit_applied,
      upper(coalesce(p.status, '')) as status,
      coalesce(p.detected_ref, p.reference_number) as reference,
      p.created_at,
      coalesce(p.verified_at, p.created_at) as recognized_at,
      n.net_received,
      (n.net_received > 0
        and upper(coalesce(p.method, '')) <> 'SYSTEM_REFUND'
        and upper(coalesce(p.status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED')) as is_settled_credit,
      (p.amount < 0
        and (upper(coalesce(p.method, '')) = 'SYSTEM_REFUND'
             or upper(coalesce(p.status, '')) = 'REFUNDED')) as is_refund,
      (upper(coalesce(p.status, '')) = 'FOR_VERIFICATION') as is_pending
    from public.payments p
    cross join lateral (
      select public.payment_net_received(p.amount, p.detected_amount, p.verified_amount) as net_received
    ) n
    where p.booking_id = b.id
  ) l
) a
cross join lateral (
  select
    greatest(0, a.settled - a.refunded) as net_settled,
    greatest(0, a.accepted - a.refunded) as verified_paid,
    (upper(coalesce(b.status, '')) = 'CANCELLED' and a.settled <= 0 and a.pending <= 0) as cancelled_no_fee
) s
cross join lateral (
  select case when s.cancelled_no_fee then 0 else coalesce(b.total_amount, 0) end as expected
) e
cross join lateral (
  select
    rate.value as rate,
    round(greatest(coalesce(b.total_amount, 0), 0) * rate.value, 2) as required
  from (
    select case
      when coalesce(b.total_amount, 0) >= (policy.pol ->> 'high_threshold')::numeric
        then (policy.pol ->> 'high_rate')::numeric
      else (policy.pol ->> 'rate')::numeric
    end as value
  ) rate
) d;

grant select on public.booking_ledger_v to authenticated, service_role;

create or replace function public.admin_record_receivable(p_booking_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ledger record;
  v_amount numeric;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can record an amount to be received.' using errcode = '42501';
  end if;

  select * into v_ledger from public.booking_ledger_v where booking_id = p_booking_id;
  if not found then
    raise exception 'Booking not found.';
  end if;
  if upper(coalesce(v_ledger.booking_status::text, '')) = 'CANCELLED' then
    raise exception 'A cancelled booking cannot have an amount to be received.';
  end if;
  if v_ledger.deferred_amount > 0 then
    raise exception 'An amount to be received is already recorded for this booking. Cancel it first to record a new one.';
  end if;

  -- derived, never typed: what the customer still owes after money and held funds
  v_amount := round(greatest(0, v_ledger.outstanding_amount - v_ledger.pending_verification), 2);
  if v_amount <= 0 then
    raise exception 'There is no unpaid balance to be received.';
  end if;

  insert into public.payments (booking_id, amount, method, status, payment_type, verified_by, verified_at, notes)
  values (p_booking_id, v_amount, 'RECEIVABLE', 'PENDING', 'Manual', auth.uid(), now(),
          'RECEIVABLE|AMOUNT:' || v_amount || coalesce('|NOTE:' || nullif(trim(p_note), ''), ''))
  returning id into v_id;

  return jsonb_build_object('payment_id', v_id, 'amount', v_amount);
end;
$fn$;

create or replace function public.admin_cancel_receivable(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public.payments;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can cancel an amount to be received.' using errcode = '42501';
  end if;
  select * into v_row from public.payments where id = p_payment_id;
  if not found or upper(coalesce(v_row.method, '')) <> 'RECEIVABLE' then
    raise exception 'That is not an amount to be received.';
  end if;
  if upper(coalesce(v_row.status, '')) <> 'PENDING' then
    raise exception 'This amount to be received is already closed.';
  end if;
  update public.payments
     set status = 'REJECTED', notes = coalesce(notes, '') || '|CANCELLED_BY:' || auth.uid()
   where id = p_payment_id;
  return jsonb_build_object('payment_id', p_payment_id, 'cancelled', true);
end;
$fn$;

revoke all on function public.admin_record_receivable(uuid, text) from public, anon;
revoke all on function public.admin_cancel_receivable(uuid) from public, anon;
grant execute on function public.admin_record_receivable(uuid, text) to authenticated;
grant execute on function public.admin_cancel_receivable(uuid) to authenticated;
