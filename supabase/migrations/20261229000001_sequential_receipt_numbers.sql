-- Sequential receipt numbers.
-- Every acknowledgement receipt gets the next number from one counter (1, 2, 3, ...), shown as 7 digits
-- (0000001). The number is given once, when a payment is verified (or a refund is recorded), and never changes.
-- Receipts must be numbered in order with no random parts, so a missing or repeated number is easy to spot.

create sequence if not exists public.payment_receipt_no_seq as bigint start 1 minvalue 1;

alter table public.payments add column if not exists receipt_no bigint;
create unique index if not exists payments_receipt_no_key on public.payments (receipt_no) where receipt_no is not null;

-- Which payments get a receipt: a verified payment with money in it, or a recorded refund.
create or replace function public.payment_gets_receipt(p_amount numeric, p_method text, p_status text)
returns boolean language sql immutable as $$
  select (coalesce(p_amount, 0) > 0
          and upper(coalesce(p_method, '')) <> 'SYSTEM_REFUND'
          and upper(coalesce(p_status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED'))
      or (coalesce(p_amount, 0) < 0
          and (upper(coalesce(p_method, '')) = 'SYSTEM_REFUND' or upper(coalesce(p_status, '')) = 'REFUNDED'))
$$;

-- Number the receipts that already exist, oldest first.
with ordered as (
  select id from public.payments
  where receipt_no is null and public.payment_gets_receipt(amount, method, status)
  order by coalesce(verified_at, created_at), created_at, id
)
update public.payments p set receipt_no = nextval('public.payment_receipt_no_seq')
from ordered o where p.id = o.id;

-- New receipts take the next number automatically. An existing number is never changed.
create or replace function public.assign_payment_receipt_no()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.receipt_no is not null then
    new.receipt_no := old.receipt_no;
  elsif new.receipt_no is null and public.payment_gets_receipt(new.amount, new.method, new.status) then
    new.receipt_no := nextval('public.payment_receipt_no_seq');
  elsif tg_op = 'INSERT' and new.receipt_no is not null then
    new.receipt_no := null; -- clients cannot choose a number
    if public.payment_gets_receipt(new.amount, new.method, new.status) then
      new.receipt_no := nextval('public.payment_receipt_no_seq');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists payments_assign_receipt_no on public.payments;
create trigger payments_assign_receipt_no
  before insert or update on public.payments
  for each row execute function public.assign_payment_receipt_no();

revoke all on sequence public.payment_receipt_no_seq from anon, authenticated;

-- Show the number in the payment ledger (added as the last column).
create or replace view public.payment_ledger_v with (security_invoker = true) as
 SELECT p.id AS payment_id,
    p.booking_id,
    b.customer_id,
    COALESCE(NULLIF(TRIM(BOTH FROM COALESCE(prof.full_name, ''::text)), ''::text), NULLIF(TRIM(BOTH FROM COALESCE(b.customer_name, ''::text)), ''::text), NULLIF(TRIM(BOTH FROM concat_ws(' '::text, b.guest_first_name, b.guest_last_name)), ''::text), NULLIF(TRIM(BOTH FROM COALESCE(b.guest_name, ''::text)), ''::text), 'Walk-in'::text) AS customer_name,
    upper(COALESCE(p.method, ''::text)) AS method,
    upper(COALESCE(p.status, ''::text)) AS status,
    p.amount,
    p.declared_amount,
    p.detected_amount,
    p.verified_amount,
    COALESCE(p.transfer_fee, 0::numeric) AS transfer_fee,
    COALESCE(p.credit_applied, 0::numeric) AS credit_applied,
    COALESCE(p.detected_ref, p.reference_number) AS reference,
    p.verified_by,
    p.verified_at,
    p.created_at,
    COALESCE(p.verified_at, p.created_at) AS recognized_at,
    n.net_received,
    n.net_received + COALESCE(p.transfer_fee, 0::numeric) AS gross_paid,
    c.is_settled_credit,
    c.is_refund,
    c.is_pending,
        CASE
            WHEN c.is_settled_credit THEN n.net_received
            WHEN c.is_refund THEN - abs(p.amount)
            ELSE 0::numeric
        END AS ledger_effect,
    p.receipt_no
   FROM payments p
     LEFT JOIN bookings b ON b.id = p.booking_id
     LEFT JOIN profiles prof ON prof.id = b.customer_id
     CROSS JOIN LATERAL ( SELECT payment_net_received(p.amount, p.detected_amount, p.verified_amount) AS net_received) n
     CROSS JOIN LATERAL ( SELECT n.net_received > 0::numeric AND upper(COALESCE(p.method, ''::text)) <> 'SYSTEM_REFUND'::text AND (upper(COALESCE(p.status, ''::text)) = ANY (ARRAY['PAID'::text, 'REFUND_PENDING'::text, 'REFUNDED'::text])) AS is_settled_credit,
            p.amount < 0::numeric AND (upper(COALESCE(p.method, ''::text)) = 'SYSTEM_REFUND'::text OR upper(COALESCE(p.status, ''::text)) = 'REFUNDED'::text) AS is_refund,
            upper(COALESCE(p.status, ''::text)) = 'FOR_VERIFICATION'::text AS is_pending) c;
