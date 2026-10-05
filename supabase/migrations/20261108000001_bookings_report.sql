-- Reports page: the bookings of a date range with their money, from the one ledger.
-- Used by the Reports "Bookings" tab, its PDF, and the reports assistant. Admin only.
-- p_from / p_to are instants (the caller sends shop-day boundaries); a booking is included when
-- it STARTS inside the window. Cancelled bookings are included and labelled.
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
          'technician', nullif(btrim(coalesce(sp.full_name, '')), ''),
          'vehicles', coalesce((
            select jsonb_agg(jsonb_build_object(
              'brand', v.brand, 'model', v.model, 'plate', v.plate_number, 'type', v.vehicle_type, 'status', v.status,
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

revoke all on function public.bookings_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.bookings_report(timestamptz, timestamptz) to authenticated;
