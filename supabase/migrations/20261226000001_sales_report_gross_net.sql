-- Reports: gross sales, discounts & promos, net sales and average sale.
--
-- Sales are counted per booking whose scheduled date falls in the chosen period and that was not cancelled or a
-- no-show (the work the shop sold, whether or not it has been paid yet):
--   gross sales        = what the services cost before any discount
--   discounts & promos = promo code discount on the booking + any promo price cut on its services
--   net sales          = what the customers were charged (gross sales - discounts & promos)
--   average sale       = net sales / number of those bookings
-- Everything else in the report (refunds, pending, outstanding, deferred, customer credit, the money-in chart and
-- breakdowns) is unchanged.

create or replace function public.sales_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
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
  sold as (
    select b.id,
           coalesce(b.total_amount, 0) as net_sale,
           coalesce(b.discount_amount_snapshot, 0)
             + coalesce((select sum(greatest(coalesce(bvs.base_price, 0) - coalesce(bvs.final_price, bvs.base_price, 0), 0))
                           from public.booking_vehicles bv
                           join public.booking_vehicle_services bvs on bvs.booking_vehicle_id = bv.id
                          where bv.booking_id = b.id), 0) as discount
      from public.bookings b
     where b.start_datetime >= p_from and b.start_datetime < p_to
       and lower(coalesce(b.status::text, '')) not in ('cancelled', 'no_show', 'flagged_noshow')
  ),
  sales as (
    select coalesce(sum(net_sale), 0) as net_sales,
           coalesce(sum(discount), 0) as discounts,
           count(*) as sales_count
      from sold
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
        select coalesce(nullif(bvs.service_name_snapshot, ''), nullif(bvs.service_name, ''), 'Unknown') as name, count(*) as cnt
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
      coalesce(sum(excess_amount), 0) as overpayments,
      coalesce(sum(deferred_amount) filter (
        where upper(coalesce(booking_status, '')) not in ('CANCELLED', 'RELEASED', 'NO_SHOW', 'FLAGGED_NOSHOW')
      ), 0) as deferred_receivables
    from public.booking_ledger_v
  ),
  credit as (
    select coalesce(sum(amount), 0) as customer_credit_liability from public.customer_credit_ledger
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'gross_sales', round(sa.net_sales + sa.discounts, 2),
    'discounts', round(sa.discounts, 2),
    'net_sales', round(sa.net_sales, 2),
    'sales_count', sa.sales_count,
    'average_sale', case when sa.sales_count > 0 then round(sa.net_sales / sa.sales_count, 2) else 0 end,
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
    'deferred_receivables', round(b.deferred_receivables, 2),
    'customer_credit_liability', round(c.customer_credit_liability, 2),
    'by_method', m.rows,
    'top_services', s.rows,
    'ledger_rule', 'net received = admin-verified amount, else OCR net, else recorded amount; transfer fees excluded'
  )
    into v_result
    from totals t, sales sa, methods m, services s, balances b, credit c;

  return v_result;
end;
$function$;
