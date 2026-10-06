-- The printable report covers a date range, not only one day: daily_report(first day, last day). With no last day it is
-- the single day, as before. The report names the same figures as the screen (net money received, refunds, bookings).
drop function if exists public.daily_report(date);
create or replace function public.daily_report(p_day date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_tz text := public.shop_timezone();
  v_day date := coalesce(p_day, (now() at time zone public.shop_timezone())::date);
  v_from timestamptz := (v_day::timestamp at time zone public.shop_timezone());
  v_last date := greatest(coalesce(p_to, coalesce(p_day, (now() at time zone public.shop_timezone())::date)), coalesce(p_day, (now() at time zone public.shop_timezone())::date));
  v_to timestamptz := ((v_last + 1)::timestamp at time zone public.shop_timezone());
  v_received jsonb;
  v_refunds jsonb;
  v_awaiting jsonb;
  v_bookings jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  if v_last - v_day > 92 then
    raise exception 'The range is too long (maximum 93 days)' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'total', coalesce(sum(net_received), 0),
    'fees', coalesce(sum(transfer_fee), 0),
    'count', count(*),
    'by_method', coalesce((
      select jsonb_agg(jsonb_build_object('method', method, 'total', total, 'count', cnt) order by total desc)
        from (select upper(coalesce(method, 'UNKNOWN')) as method, sum(net_received) as total, count(*) as cnt
                from public.payment_ledger_v
               where is_settled_credit and recognized_at >= v_from and recognized_at < v_to
               group by 1) m), '[]'::jsonb),
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'at', recognized_at, 'booking', upper(left(booking_id::text, 8)), 'customer', customer_name,
      'method', upper(coalesce(method, 'UNKNOWN')), 'amount', net_received, 'reference', reference) order by recognized_at), '[]'::jsonb))
    into v_received
    from public.payment_ledger_v
   where is_settled_credit and recognized_at >= v_from and recognized_at < v_to;

  select jsonb_build_object(
    'total', coalesce(sum(abs(amount)), 0),
    'count', count(*),
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'at', created_at, 'booking', upper(left(booking_id::text, 8)), 'customer', customer_name,
      'amount', abs(amount), 'reference', reference) order by created_at), '[]'::jsonb))
    into v_refunds
    from public.payment_ledger_v
   where is_refund and created_at >= v_from and created_at < v_to;

  select jsonb_build_object('count', count(*), 'total', coalesce(sum(amount), 0))
    into v_awaiting
    from public.payment_ledger_v
   where is_pending;

  v_bookings := public.bookings_report(v_from, v_to);

  return jsonb_build_object(
    'day', v_day, 'last_day', v_last, 'timezone', v_tz, 'from', v_from, 'to', v_to,
    'received', v_received, 'refunds', v_refunds, 'awaiting', v_awaiting,
    'totals', v_bookings -> 'totals', 'bookings', v_bookings -> 'bookings');
end;
$fn$;
revoke all on function public.daily_report(date, date) from public, anon;
grant execute on function public.daily_report(date, date) to authenticated;
