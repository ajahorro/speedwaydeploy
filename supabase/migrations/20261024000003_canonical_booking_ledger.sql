-- ============================================================================
-- Phase 1: ONE booking-money ledger.
--
-- Before this migration the same "how much has this booking paid" rule was
-- written out separately in booking_net_paid, booking_verified_paid,
-- booking_financial_ledger and staff_booking_has_verified_downpayment, and the
-- 30%/50% downpayment tier was hard-coded in SQL and in three JS files.
--
-- After it:
--   * payment_net_received() is the only per-transaction "money received" rule.
--   * payment_ledger_v is the only per-transaction projection.
--   * booking_ledger_v is the only per-booking projection; every booking-level
--     SQL function now reads it instead of re-summing payments.
--   * The downpayment policy lives in business_config and is read through
--     booking_required_downpayment() / shop_downpayment_policy().
--   * sales_report() / sales_report_daily() aggregate payment_ledger_v, so the
--     financial reports can never disagree with booking balances.
--
-- Value-preserving: defaults equal the old hard-coded tiers, and the per-row
-- rule only differs from before where an administrator verified a figure that
-- differs from the OCR reading (the human figure now wins, as intended).
-- ============================================================================

-- ── 1. Downpayment policy (configurable; defaults = previous constants) ─────
alter table public.business_config
  add column if not exists downpayment_min_total numeric not null default 1000,
  add column if not exists downpayment_rate numeric not null default 0.30,
  add column if not exists downpayment_high_threshold numeric not null default 2000,
  add column if not exists downpayment_high_rate numeric not null default 0.50;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_config_downpayment_policy_check') then
    alter table public.business_config
      add constraint business_config_downpayment_policy_check check (
        downpayment_rate > 0 and downpayment_rate <= 1
        and downpayment_high_rate > 0 and downpayment_high_rate <= 1
        and downpayment_min_total >= 0
        and downpayment_high_threshold >= 0
      );
  end if;
end $$;

-- The shop configuration row. business_config is treated as a singleton; every
-- reader resolves the same row (lowest id) through this one function.
create or replace function public.shop_downpayment_policy()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select jsonb_build_object(
      'min_total', downpayment_min_total,
      'rate', downpayment_rate,
      'high_threshold', downpayment_high_threshold,
      'high_rate', downpayment_high_rate
    )
      from public.business_config
     order by id
     limit 1
  ), jsonb_build_object('min_total', 1000, 'rate', 0.30, 'high_threshold', 2000, 'high_rate', 0.50));
$$;

create or replace function public.booking_downpayment_rate(p_total numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(p_total, 0) >= (pol ->> 'high_threshold')::numeric then (pol ->> 'high_rate')::numeric
    else (pol ->> 'rate')::numeric
  end
    from (select public.shop_downpayment_policy() as pol) p;
$$;

-- Amount that must be verified before work can start (and the amount a
-- "downpayment" receipt must cover). The tier is chosen by the booking total.
create or replace function public.booking_required_downpayment(p_total numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select round(greatest(coalesce(p_total, 0), 0) * public.booking_downpayment_rate(p_total), 2);
$$;

-- Whether a customer may pay a downpayment instead of the full amount.
create or replace function public.booking_downpayment_allowed(p_total numeric)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_total, 0) >= (public.shop_downpayment_policy() ->> 'min_total')::numeric;
$$;

grant execute on function public.shop_downpayment_policy() to anon, authenticated;
grant execute on function public.booking_downpayment_rate(numeric) to anon, authenticated;
grant execute on function public.booking_required_downpayment(numeric) to anon, authenticated;
grant execute on function public.booking_downpayment_allowed(numeric) to anon, authenticated;

-- ── 2. Per-transaction rule ──────────────────────────────────────────────────
-- declared_amount: what the customer said they paid (kept even after verification)
-- verified_amount: the figure an administrator confirmed
alter table public.payments
  add column if not exists declared_amount numeric,
  add column if not exists verified_amount numeric;

comment on column public.payments.amount is
  'Transaction amount. After administrator verification this equals verified_amount (kept for backward compatibility).';
comment on column public.payments.declared_amount is
  'Amount declared at submission, preserved when verification rewrites amount.';
comment on column public.payments.verified_amount is
  'Amount an administrator confirmed as received. Takes precedence over the OCR reading.';
comment on column public.payments.detected_amount is
  'OCR-detected net amount received (evidence, not settlement).';
comment on column public.payments.transfer_fee is
  'Fee charged by the customer''s bank/e-wallet. Never counts toward settlement.';

-- Historical manual overrides rewrote amount with the verified figure.
update public.payments
   set verified_amount = amount
 where verified_amount is null
   and coalesce(manual_override, false) = true
   and amount > 0;

-- The ONE "money received" rule for a transaction:
--   administrator-verified amount > OCR-detected net amount > recorded amount.
-- Transfer fees are never included.
create or replace function public.payment_net_received(
  p_amount numeric,
  p_detected_amount numeric,
  p_verified_amount numeric
)
returns numeric
language sql
immutable
as $$
  select case
    when coalesce(p_verified_amount, 0) > 0 then p_verified_amount
    when coalesce(p_detected_amount, 0) > 0 then p_detected_amount
    else coalesce(p_amount, 0)
  end;
$$;

grant execute on function public.payment_net_received(numeric, numeric, numeric) to anon, authenticated;

-- One row per payment, with every derived figure the UI and reports need.
create or replace view public.payment_ledger_v
with (security_invoker = true)
as
select
  p.id as payment_id,
  p.booking_id,
  b.customer_id,
  coalesce(
    nullif(trim(coalesce(prof.full_name, '')), ''),
    nullif(trim(coalesce(b.customer_name, '')), ''),
    nullif(trim(concat_ws(' ', b.guest_first_name, b.guest_last_name)), ''),
    nullif(trim(coalesce(b.guest_name, '')), ''),
    'Walk-in'
  ) as customer_name,
  upper(coalesce(p.method, '')) as method,
  upper(coalesce(p.status, '')) as status,
  p.amount,
  p.declared_amount,
  p.detected_amount,
  p.verified_amount,
  coalesce(p.transfer_fee, 0) as transfer_fee,
  coalesce(p.credit_applied, 0) as credit_applied,
  coalesce(p.detected_ref, p.reference_number) as reference,
  p.verified_by,
  p.verified_at,
  p.created_at,
  -- When the transaction counts on the books: verification time for settled
  -- credits, creation time for refunds and pending rows.
  coalesce(p.verified_at, p.created_at) as recognized_at,
  n.net_received,
  n.net_received + coalesce(p.transfer_fee, 0) as gross_paid,
  c.is_settled_credit,
  c.is_refund,
  c.is_pending,
  case
    when c.is_settled_credit then n.net_received
    when c.is_refund then -abs(p.amount)
    else 0
  end as ledger_effect
from public.payments p
left join public.bookings b on b.id = p.booking_id
left join public.profiles prof on prof.id = b.customer_id
cross join lateral (
  select public.payment_net_received(p.amount, p.detected_amount, p.verified_amount) as net_received
) n
cross join lateral (
  select
    (n.net_received > 0
      and upper(coalesce(p.method, '')) <> 'SYSTEM_REFUND'
      and upper(coalesce(p.status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED')) as is_settled_credit,
    (p.amount < 0
      and (upper(coalesce(p.method, '')) = 'SYSTEM_REFUND'
           or upper(coalesce(p.status, '')) = 'REFUNDED')) as is_refund,
    (upper(coalesce(p.status, '')) = 'FOR_VERIFICATION') as is_pending
) c;

grant select on public.payment_ledger_v to authenticated, service_role;

-- ── 3. Per-booking projection ────────────────────────────────────────────────
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
  a.last_settled_at
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

-- ── 4. Existing booking-level functions now read the projection ─────────────
create or replace function public.booking_financial_ledger(p_booking_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_row public.booking_ledger_v%rowtype;
begin
  select * into v_row from public.booking_ledger_v where booking_id = p_booking_id;
  if not found then
    raise exception 'booking_financial_ledger: booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  return to_jsonb(v_row) || jsonb_build_object(
    'ledger_rule',
    'net received = admin-verified amount, else OCR net, else recorded amount; transfer fees excluded; FOR_VERIFICATION reported separately'
  );
end;
$$;

create or replace function public.booking_net_paid(p_booking_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select net_settled from public.booking_ledger_v where booking_id = p_booking_id), 0);
$$;

create or replace function public.booking_verified_paid(p_booking_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select net_settled from public.booking_ledger_v where booking_id = p_booking_id), 0)::numeric;
$$;

create or replace function public.staff_booking_has_verified_downpayment(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.booking_ledger_v l
      join public.profiles p
        on p.id = auth.uid()
       and upper(p.role) = 'STAFF'
     where l.booking_id = p_booking_id
       and l.staff_id = auth.uid()
       and l.downpayment_met
  );
$$;

grant execute on function public.booking_financial_ledger(uuid) to authenticated, service_role;
grant execute on function public.booking_net_paid(uuid) to authenticated, service_role;

-- Bulk read for list pages: one call instead of one per booking.
create or replace function public.booking_ledgers(p_booking_ids uuid[])
returns setof public.booking_ledger_v
language sql
stable
set search_path = public
as $$
  select * from public.booking_ledger_v where booking_id = any(p_booking_ids);
$$;

grant execute on function public.booking_ledgers(uuid[]) to authenticated, service_role;

-- ── 5. One verification path and one rejection path for every admin screen ─
-- Before: Admin Payments used an RPC while Booking Details wrote payments
-- directly from the browser, with different lock/audit behaviour.

-- Approve a submitted payment. p_override marks a deliberate decision that
-- contradicts the OCR reading (e.g. below the required downpayment).
create or replace function public.admin_verify_payment(
  p_payment_id uuid,
  p_booking_id uuid,
  p_verified_amount numeric,
  p_note text default null,
  p_override boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now    timestamptz := now();
  v_amount numeric := coalesce(p_verified_amount, 0);
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required to verify a payment' using errcode = '42501';
  end if;
  if v_amount <= 0 then
    raise exception 'A verified amount greater than zero is required';
  end if;

  select upper(coalesce(status, '')) into v_status
    from public.payments
   where id = p_payment_id and booking_id = p_booking_id
   for update;
  if not found then
    raise exception 'Payment does not belong to booking or was not found';
  end if;
  if v_status in ('PAID', 'REFUNDED', 'REFUND_PENDING') then
    raise exception 'This payment has already been settled (%).', v_status using errcode = '23514';
  end if;

  update public.payments
     set declared_amount = coalesce(declared_amount, amount),
         verified_amount = v_amount,
         amount = v_amount,
         status = 'PAID',
         verified_by = auth.uid(),
         verified_at = v_now,
         -- A human decision always locks out delayed OCR writes.
         ocr_locked = true,
         manual_override = coalesce(manual_override, false) or p_override,
         overridden_by = case when p_override then auth.uid() else overridden_by end,
         overridden_at = case when p_override then v_now else overridden_at end,
         notes = concat_ws('|', notes, case when p_override then '[MANUAL_OVERRIDE]' else '[VERIFIED]' end, nullif(p_note, ''))
   where id = p_payment_id;

  -- One audit row per action: trg_audit_payment_change records normal
  -- verifications (PAYMENT_VERIFIED) and deliberately skips overrides, which
  -- are recorded here.
  if p_override then
    insert into public.audit_logs (
      booking_id, action_type, details, actor_name, actor_role, actor_id, metadata
    ) values (
      p_booking_id,
      'MANUAL_OVERRIDE_CONFIRM',
      format('Administrator manually confirmed a flagged payment as ₱%s. Automated OCR updates are now locked out.', v_amount),
      'Administrator', 'ADMIN', auth.uid(),
      jsonb_build_object('payment_id', p_payment_id, 'verified_amount', v_amount, 'override', true)
    );
  end if;

  return jsonb_build_object(
    'payment_id', p_payment_id,
    'booking_id', p_booking_id,
    'status', 'PAID',
    'manual_override', p_override,
    'ledger', public.booking_financial_ledger(p_booking_id)
  );
end;
$$;

-- Backward-compatible entry point for older clients: always an override.
create or replace function public.admin_override_payment_to_paid(
  p_payment_id uuid,
  p_booking_id uuid,
  p_verified_amount numeric,
  p_note text default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.admin_verify_payment(p_payment_id, p_booking_id, p_verified_amount, p_note, true);
$$;

-- Reject a submitted payment.
--   p_queue_refund = true  : money was received; hold it as REFUND_PENDING and
--                            queue a refund on the booking.
--   p_queue_refund = false : the proof is invalid; mark REJECTED so the
--                            customer re-submits.
create or replace function public.admin_reject_payment(
  p_payment_id uuid,
  p_booking_id uuid,
  p_reason text,
  p_queue_refund boolean default false,
  p_refund_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_amount numeric;
  v_next_status text := case when p_queue_refund then 'REFUND_PENDING' else 'REJECTED' end;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required to reject a payment' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A rejection reason is required';
  end if;

  select * into v_payment
    from public.payments
   where id = p_payment_id and booking_id = p_booking_id
   for update;
  if not found then
    raise exception 'Payment does not belong to booking or was not found';
  end if;
  if upper(coalesce(v_payment.status, '')) in ('PAID', 'REFUNDED', 'REFUND_PENDING') then
    raise exception 'This payment has already been settled (%).', upper(v_payment.status) using errcode = '23514';
  end if;

  v_amount := public.payment_net_received(v_payment.amount, v_payment.detected_amount, v_payment.verified_amount);

  update public.payments
     set status = v_next_status,
         rejection_reason = p_reason,
         ocr_locked = true,
         notes = concat_ws('|', notes, format('REJECTED_AMOUNT:%s', v_amount), format('REJECTION_REASON:%s', p_reason))
   where id = p_payment_id;

  if p_queue_refund then
    update public.bookings
       set refund_status = 'QUEUED',
           refund_notes = coalesce(nullif(p_refund_note, ''), format('Rejected payment: %s', p_reason))
     where id = p_booking_id;
  end if;

  -- Audited by trg_audit_payment_change (PAYMENT_REJECTED / PAYMENT_REFUND_QUEUED);
  -- the reason is stored on the payment row (rejection_reason).


  return jsonb_build_object(
    'payment_id', p_payment_id,
    'booking_id', p_booking_id,
    'status', v_next_status,
    'refund_queued', p_queue_refund,
    'ledger', public.booking_financial_ledger(p_booking_id)
  );
end;
$$;

revoke all on function public.admin_verify_payment(uuid, uuid, numeric, text, boolean) from public, anon;
revoke all on function public.admin_reject_payment(uuid, uuid, text, boolean, text) from public, anon;
grant execute on function public.admin_verify_payment(uuid, uuid, numeric, text, boolean) to authenticated;
grant execute on function public.admin_reject_payment(uuid, uuid, text, boolean, text) to authenticated;

-- ── 6. Reports (admin only), built on payment_ledger_v ──────────────────────
create or replace function public.sales_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  with window_rows as (
    select *
      from public.payment_ledger_v
     where (is_settled_credit and recognized_at >= p_from and recognized_at < p_to)
        or (is_refund and created_at >= p_from and created_at < p_to)
        or (is_pending and created_at >= p_from and created_at < p_to)
  ),
  totals as (
    select
      coalesce(sum(gross_paid) filter (where is_settled_credit), 0) as gross_collected,
      coalesce(sum(transfer_fee) filter (where is_settled_credit), 0) as transfer_fees,
      coalesce(sum(net_received) filter (where is_settled_credit), 0) as net_received,
      coalesce(sum(abs(amount)) filter (where is_refund), 0) as refunds,
      coalesce(sum(amount) filter (where is_pending), 0) as pending_verification,
      count(*) filter (where is_settled_credit) as transaction_count,
      count(distinct booking_id) filter (where is_settled_credit) as booking_count
    from window_rows
  ),
  methods as (
    select coalesce(jsonb_agg(jsonb_build_object('method', method, 'net_received', total, 'count', cnt) order by total desc), '[]'::jsonb) as rows
      from (
        select method, sum(net_received) as total, count(*) as cnt
          from window_rows
         where is_settled_credit
         group by method
      ) m
  ),
  services as (
    select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', cnt) order by cnt desc, name), '[]'::jsonb) as rows
      from (
        select coalesce(nullif(bvs.service_name_snapshot, ''), 'Unknown') as name, count(*) as cnt
          from (select distinct booking_id from window_rows where is_settled_credit) wb
          join public.booking_vehicles bv on bv.booking_id = wb.booking_id
          join public.booking_vehicle_services bvs on bvs.booking_vehicle_id = bv.id
         group by 1
         order by cnt desc, name
         limit 5
      ) s
  ),
  balances as (
    -- Point-in-time liabilities, not limited to the date window.
    select
      coalesce(sum(outstanding_amount) filter (
        where upper(coalesce(booking_status, '')) not in ('CANCELLED', 'RELEASED', 'NO_SHOW', 'FLAGGED_NOSHOW')
      ), 0) as outstanding_balance,
      coalesce(sum(excess_amount), 0) as overpayments
    from public.booking_ledger_v
  ),
  credit as (
    select coalesce(sum(amount), 0) as customer_credit_liability from public.customer_credit_ledger
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'gross_collected', round(t.gross_collected, 2),
    'transfer_fees', round(t.transfer_fees, 2),
    'net_received', round(t.net_received, 2),
    'refunds', round(t.refunds, 2),
    'net_revenue', round(t.net_received - t.refunds, 2),
    'pending_verification', round(t.pending_verification, 2),
    'transaction_count', t.transaction_count,
    'booking_count', t.booking_count,
    'average_ticket', case when t.booking_count > 0 then round(t.net_received / t.booking_count, 2) else 0 end,
    'outstanding_balance', round(b.outstanding_balance, 2),
    'overpayments', round(b.overpayments, 2),
    'customer_credit_liability', round(c.customer_credit_liability, 2),
    'by_method', m.rows,
    'top_services', s.rows,
    'ledger_rule', 'net received = admin-verified amount, else OCR net, else recorded amount; transfer fees excluded'
  )
    into v_result
    from totals t, methods m, services s, balances b, credit c;

  return v_result;
end;
$$;

create or replace function public.sales_report_daily(
  p_from timestamptz,
  p_to timestamptz,
  p_tz text default 'Asia/Manila'
)
returns table (
  day date,
  net_received numeric,
  refunds numeric,
  pending_verification numeric,
  transaction_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  return query
  with days as (
    select generate_series(
      (p_from at time zone p_tz)::date,
      ((p_to - interval '1 microsecond') at time zone p_tz)::date,
      interval '1 day'
    )::date as bucket
  ),
  ledger_rows as (
    select
      case when l.is_settled_credit then (l.recognized_at at time zone p_tz)::date
           else (l.created_at at time zone p_tz)::date end as bucket,
      l.is_settled_credit, l.is_refund, l.is_pending, l.net_received, l.amount
      from public.payment_ledger_v l
     where (l.is_settled_credit and l.recognized_at >= p_from and l.recognized_at < p_to)
        or ((l.is_refund or l.is_pending) and l.created_at >= p_from and l.created_at < p_to)
  )
  select
    d.bucket,
    round(coalesce(sum(r.net_received) filter (where r.is_settled_credit), 0), 2),
    round(coalesce(sum(abs(r.amount)) filter (where r.is_refund), 0), 2),
    round(coalesce(sum(r.amount) filter (where r.is_pending), 0), 2),
    count(r.bucket) filter (where r.is_settled_credit)
    from days d
    left join ledger_rows r on r.bucket = d.bucket
   group by d.bucket
   order by d.bucket;
end;
$$;

revoke all on function public.sales_report(timestamptz, timestamptz) from public, anon;
revoke all on function public.sales_report_daily(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.sales_report(timestamptz, timestamptz) to authenticated;
grant execute on function public.sales_report_daily(timestamptz, timestamptz, text) to authenticated;

-- ── 7. Secure booking creation uses the configured downpayment policy ──────
CREATE OR REPLACE FUNCTION public.create_booking_atomic_secure(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_payment jsonb;
  v_scan_id uuid;
  v_scan public.ocr_scan_sessions%rowtype;
  v_method text;
  v_is_admin_walk_in boolean;
  v_requires_scan boolean;
  v_verdict text;
  v_metadata jsonb;
  v_total_amount numeric;
  v_required_amount numeric;
  v_scanned_amount numeric;
  v_payment_type text;
  v_result jsonb;
  v_booking_id uuid;
  v_payment_id uuid;
begin
  v_payment := v_payload -> 'payment';
  v_method := upper(coalesce(v_payment ->> 'method', ''));
  v_is_admin_walk_in := coalesce((v_payload #>> '{booking,is_walk_in}')::boolean, false)
    and public.is_admin();
  v_requires_scan := v_payment is not null
    and jsonb_typeof(v_payment) = 'object'
    and v_method not in ('', 'CASH')
    and not v_is_admin_walk_in;

  if nullif(v_payment ->> 'ocr_scan_id', '') is not null then
    v_scan_id := (v_payment ->> 'ocr_scan_id')::uuid;
  elsif v_requires_scan then
    raise exception 'A current server-verified receipt scan is required.'
      using errcode = '23514';
  end if;

  if v_scan_id is not null then
    select * into v_scan
      from public.ocr_scan_sessions
     where id = v_scan_id
       and active
       and expires_at > now()
     for update;

    if not found then
      raise exception 'The receipt scan is missing, expired, or already used. Scan the receipt again.'
        using errcode = '23514';
    end if;

    v_verdict := case when v_is_admin_walk_in
      then upper(coalesce(v_payment ->> 'verdict', 'PAID'))
      else v_scan.payment_verdict
    end;
    v_metadata := jsonb_set(v_scan.ocr_metadata, '{payment_verdict}', to_jsonb(v_verdict), true);
    if not v_is_admin_walk_in then
      v_total_amount := nullif(v_payload #>> '{booking,total_amount}', '')::numeric;
      v_payment_type := lower(coalesce(v_payment ->> 'payment_type', 'full'));
      if v_total_amount is null or v_total_amount <= 0 then
        raise exception 'A valid booking total is required for receipt verification.'
          using errcode = '23514';
      end if;
      if v_payment_type = 'downpayment' then
        v_required_amount := public.booking_required_downpayment(v_total_amount);
      elsif v_payment_type = 'full' then
        v_required_amount := v_total_amount;
      else
        raise exception 'Unsupported customer payment type for receipt verification.'
          using errcode = '23514';
      end if;
      if not coalesce((v_metadata ->> 'extraction_unavailable')::boolean, false)
        and abs(coalesce(nullif(v_metadata ->> 'requiredAmount', '')::numeric, -1) - v_required_amount) > 0.01 then
        raise exception 'The booking total changed after the receipt was scanned. Scan the receipt again.'
          using errcode = '23514';
      end if;
      v_scanned_amount := nullif(v_metadata ->> 'amount', '')::numeric;
      if not coalesce((v_metadata ->> 'extraction_unavailable')::boolean, false)
         and coalesce(v_scanned_amount, 0) < v_required_amount - 1.00 then
        raise exception 'The scanned receipt is below the required payment amount.'
          using errcode = '23514';
      end if;
    end if;
    v_payment := jsonb_set(v_payment, '{verdict}', to_jsonb(v_verdict), true);
    if not v_is_admin_walk_in then
      v_payment := jsonb_set(v_payment, '{status}', to_jsonb('FOR_VERIFICATION'::text), true);
      v_payload := jsonb_set(v_payload, '{booking,payment_status}', to_jsonb('pending'::text), true);
    end if;
    v_payment := jsonb_set(v_payment, '{detected_amount}', coalesce(v_metadata -> 'amount', 'null'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{detected_ref}', coalesce(v_metadata -> 'referenceNumber', 'null'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{reference_number}', coalesce(v_metadata -> 'referenceNumber', 'null'::jsonb), true);
      v_payment := jsonb_set(v_payment, '{receipt_url}', coalesce(v_metadata -> 'receipt_url', 'null'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{amount}', to_jsonb(v_required_amount), true);
    v_payment := jsonb_set(v_payment, '{transfer_fee}', coalesce(v_metadata -> 'transferFee', '0'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{net_credit}', coalesce(v_metadata -> 'amount', 'null'::jsonb), true);
    v_payment := jsonb_set(v_payment, '{ocr_metadata}', v_metadata, true);
    v_payload := jsonb_set(v_payload, '{payment}', v_payment, true);
    v_payload := jsonb_set(v_payload, '{booking,ocr_metadata}', v_metadata, true);
  elsif not v_is_admin_walk_in and v_payment is not null and jsonb_typeof(v_payment) = 'object' then
    v_payment := jsonb_set(v_payment, '{status}', to_jsonb('PENDING'::text), true);
    v_payload := jsonb_set(v_payload, '{payment}', v_payment, true);
    if v_method = 'CASH' then
      v_payload := jsonb_set(v_payload, '{booking,payment_status}', to_jsonb('unpaid'::text), true);
    end if;
  end if;

  v_result := public.create_booking_atomic(v_payload);
  v_booking_id := nullif(v_result #>> '{booking,id}', '')::uuid;
  v_payment_id := nullif(v_result #>> '{payment,id}', '')::uuid;

  if v_scan_id is not null then
    if v_booking_id is null or v_payment_id is null then
      raise exception 'The booking did not create a payment for its receipt scan.';
    end if;

    update public.payments
      set 
          ocr_evaluated_total = coalesce(ocr_evaluated_total, nullif(v_payload #>> '{booking,total_amount}', '')::numeric),
          ocr_evaluated_at = coalesce(ocr_evaluated_at, now())
     where id = v_payment_id
       and booking_id = v_booking_id;

    if not found then
      raise exception 'Could not attach the OCR receipt hash to its payment.';
    end if;

    update public.ocr_scan_sessions
       set active = false,
           booking_id = v_booking_id,
           payment_id = v_payment_id
     where id = v_scan_id;
  end if;

  return v_result;
end;
$function$
;
