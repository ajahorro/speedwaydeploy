-- "Deferred receivables" KPI (master plan 4.2 / 4.6): the part of unpaid balances an admin
-- deliberately deferred with "To be received". It is not money received. It is a point-in-time
-- figure on active bookings, like the outstanding balance, and comes from the same ledger view.
do $patch$
declare
  v_def text;
  v_old1 text := 'coalesce(sum(excess_amount), 0) as overpayments';
  v_new1 text := 'coalesce(sum(excess_amount), 0) as overpayments,
      coalesce(sum(deferred_amount) filter (
        where upper(coalesce(booking_status, '''')) not in (''CANCELLED'', ''RELEASED'', ''NO_SHOW'', ''FLAGGED_NOSHOW'')
      ), 0) as deferred_receivables';
  v_old2 text := '''overpayments'', round(b.overpayments, 2),';
  v_new2 text := '''overpayments'', round(b.overpayments, 2),
    ''deferred_receivables'', round(b.deferred_receivables, 2),';
begin
  select pg_get_functiondef('public.sales_report(timestamptz,timestamptz)'::regprocedure) into v_def;
  if position(v_old1 in v_def) = 0 or position(v_old2 in v_def) = 0 then
    raise exception 'sales_report layout changed; patch not applied';
  end if;
  execute replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
end
$patch$;
