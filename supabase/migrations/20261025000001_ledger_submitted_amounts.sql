-- ============================================================================
-- Phase 2: customer-facing amounts for emails and receipts come from the ledger.
--
-- The booking-lifecycle emails computed their own totals (counting transfer
-- fees toward the balance and never subtracting refunds). These appended
-- columns give them the same figures as every other screen:
--   submitted_*      settled money + receipts awaiting verification
--   verified_gross_paid   accepted money including the customer's transfer fee
-- Columns are only appended, so existing readers are unaffected.
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
  (s.verified_paid >= d.required) as downpayment_met,
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
  round(greatest(0, (s.net_settled + a.pending_net) - e.expected), 2) as submitted_excess
from public.bookings b
left join public.profiles prof on prof.id = b.customer_id
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
