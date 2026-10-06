-- The bookings report now names the technician of each vehicle (a booking can have several).
create or replace function public.bookings_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_rows jsonb;
  v_totals jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'A valid date range is required' using errcode = '22023';
  end if;
  if p_to - p_from > interval '93 days' then
    raise exception 'The range is too long (maximum 93 days)' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row_json order by start_at), '[]'::jsonb)
    into v_rows
    from (
      select
        l.start_datetime as start_at,
        jsonb_build_object(
          'booking_id', l.booking_id,
          'reference', upper(left(l.booking_id::text, 8)),
          'customer_name', l.customer_name,
          'contact_number', b.contact_number,
          'status', l.booking_status,
          'start_datetime', l.start_datetime,
          'end_datetime', b.end_datetime,
          'technician', (select string_agg(distinct pr.full_name, ', ') from public.booking_vehicles tv join public.profiles pr on pr.id = tv.staff_id where tv.booking_id = l.booking_id and nullif(btrim(coalesce(pr.full_name, '')), '') is not null),
          'vehicles', coalesce((
            select jsonb_agg(jsonb_build_object(
              'technician', (select nullif(btrim(coalesce(pr.full_name, '')), '') from public.profiles pr where pr.id = v.staff_id), 'brand', v.brand, 'model', v.model, 'plate', v.plate_number, 'type', v.vehicle_type, 'status', v.status,
              'services', coalesce((
                select jsonb_agg(jsonb_build_object('name', s.service_name, 'price', s.price) order by s.service_name)
                  from public.booking_vehicle_services s where s.booking_vehicle_id = v.id), '[]'::jsonb)
            ) order by v.plate_number)
              from public.booking_vehicles v where v.booking_id = l.booking_id), '[]'::jsonb),
          'total', l.original_amount,
          'expected', l.expected_amount,
          'paid', l.net_settled,
          'refunded', l.refunded_amount,
          'balance', l.outstanding_amount,
          'deferred', l.deferred_amount,
          'pending_verification', l.pending_verification,
          'paid_status', l.paid_status,
          'methods', coalesce((
            select jsonb_agg(distinct upper(p.method))
              from public.payments p
             where p.booking_id = l.booking_id and upper(coalesce(p.status, '')) in ('PAID', 'REFUND_PENDING', 'REFUNDED', 'FOR_VERIFICATION')
               and upper(coalesce(p.method, '')) not in ('SYSTEM_REFUND', 'RECEIVABLE')), '[]'::jsonb)
        ) as row_json
      from public.booking_ledger_v l
      join public.bookings b on b.id = l.booking_id
      left join public.profiles sp on sp.id = b.staff_id
      where l.start_datetime >= p_from and l.start_datetime < p_to
    ) q;

  select jsonb_build_object(
      'count', count(*),
      'active_count', count(*) filter (where upper(l.booking_status::text) not in ('CANCELLED')),
      'total_value', coalesce(sum(l.original_amount) filter (where upper(l.booking_status::text) not in ('CANCELLED')), 0),
      'paid', coalesce(sum(l.net_settled), 0),
      'refunded', coalesce(sum(l.refunded_amount), 0),
      'balance', coalesce(sum(l.outstanding_amount) filter (where upper(l.booking_status::text) not in ('CANCELLED')), 0),
      'deferred', coalesce(sum(l.deferred_amount) filter (where upper(l.booking_status::text) not in ('CANCELLED')), 0),
      'pending_verification', coalesce(sum(l.pending_verification), 0)
    )
    into v_totals
    from public.booking_ledger_v l
   where l.start_datetime >= p_from and l.start_datetime < p_to;

  return jsonb_build_object('from', p_from, 'to', p_to, 'totals', v_totals, 'bookings', v_rows);
end;
$fn$;

-- ============================================================================
-- Daily report for the administrator (printed from Reports): one day in the shop's time zone.
--   * received:   money received that day (net of transfer fees), by method, and each payment;
--   * refunds:    refunds issued that day;
--   * awaiting:   payments still waiting for verification;
--   * bookings:   the appointments of that day with who booked them, the vehicles, the technicians and the
--                 money for each (the same figures as the bookings report);
--   * totals:     the bookings report totals for the day (booked value, paid, balance still owed).
-- ============================================================================
create or replace function public.daily_report(p_day date default null)
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
  v_to timestamptz := ((v_day + 1)::timestamp at time zone public.shop_timezone());
  v_received jsonb;
  v_refunds jsonb;
  v_awaiting jsonb;
  v_bookings jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
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
    'day', v_day, 'timezone', v_tz, 'from', v_from, 'to', v_to,
    'received', v_received, 'refunds', v_refunds, 'awaiting', v_awaiting,
    'totals', v_bookings -> 'totals', 'bookings', v_bookings -> 'bookings');
end;
$fn$;

revoke all on function public.daily_report(date) from public, anon;
grant execute on function public.daily_report(date) to authenticated;
