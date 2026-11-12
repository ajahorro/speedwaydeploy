-- A booking keeps the downpayment rule (rate / threshold) that applied when it was created.
-- Changing the rule in Business Hub affects new bookings only; it no longer moves bookings that already exist
-- from "downpayment met" to "not met" (or the reverse).

alter table public.bookings add column if not exists downpayment_policy jsonb;

comment on column public.bookings.downpayment_policy is
  'Downpayment rule in force when the booking was created (min_total, rate, high_threshold, high_rate). Read by booking_ledger_v instead of the live rule.';

-- existing bookings take the rule in force today (the only one on record)
update public.bookings set downpayment_policy = public.shop_downpayment_policy() where downpayment_policy is null;

create or replace function public.stamp_booking_downpayment_policy()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.downpayment_policy is null then
    new.downpayment_policy := public.shop_downpayment_policy();
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_booking_downpayment_policy on public.bookings;
create trigger trg_stamp_booking_downpayment_policy
  before insert on public.bookings
  for each row execute function public.stamp_booking_downpayment_policy();

do $$
declare v_def text := pg_get_viewdef('public.booking_ledger_v'::regclass);
begin
  if position('b.downpayment_policy' in v_def) > 0 then return; end if;
  if position('policy.pol' in v_def) = 0 then raise exception 'booking_ledger_v changed; update this migration'; end if;
  execute 'create or replace view public.booking_ledger_v with (security_invoker = true) as '
    || replace(v_def, 'policy.pol', 'COALESCE(b.downpayment_policy, policy.pol)');
end $$;
grant select on public.booking_ledger_v to authenticated, service_role;
