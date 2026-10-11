-- Two accuracy fixes found by the accuracy stress test.
--
-- 1. A cancelled (or no-show) booking that was paid and then refunded, keeping a cancellation fee, still showed the
--    refunded part as "outstanding": outstanding = booking total − (paid − refunded), so a ₱420 booking refunded ₱320
--    (₱100 fee kept) looked like ₱320 owed. A booking that will not go ahead owes nothing. (The booking's own total and
--    expected amount are left as they are.)
-- 2. A promotion that had just been archived was still honoured when a new booking was created: the price check allowed
--    a day of grace after a promotion ended and did not look at the archived mark at all. An archived promotion is off
--    immediately.

do $patch$
declare
  v_def text;
  v_new text;
begin
  select pg_get_viewdef('public.booking_ledger_v'::regclass) into v_def;
  v_def := regexp_replace(v_def, ';\s*$', '');
  -- (an earlier draft of this fix changed the expected amount instead; put that back if it is there)
  v_def := regexp_replace(v_def,
    '\s+WHEN \(upper\(COALESCE\(b\.status, ''''::text\)\) = ANY \(ARRAY\[[^\]]*\]\)\) THEN s\.net_settled', '');
  v_new := replace(v_def,
    'round(GREATEST((0)::numeric, (e.expected - (a.settled - a.refunded))), 2) AS outstanding_amount',
    'CASE WHEN upper(COALESCE(b.status, ''''::text)) = ANY (ARRAY[''CANCELLED''::text, ''FLAGGED_NOSHOW''::text, ''NO_SHOW''::text]) THEN (0)::numeric
         ELSE round(GREATEST((0)::numeric, (e.expected - (a.settled - a.refunded))), 2) END AS outstanding_amount');
  if v_new = v_def and v_def not like '%FLAGGED_NOSHOW%' then raise exception 'booking_ledger_v layout changed; patch not applied'; end if;
  execute 'create or replace view public.booking_ledger_v with (security_invoker = true) as ' || v_new;

  select pg_get_functiondef('public.assert_booking_pricing'::regproc) into v_def;
  if v_def like '%archived_at%' then return; end if;
  v_new := replace(v_def,
    'continue when (v_from is not null and v_from > now() + interval ''1 day'')',
    'continue when nullif(v_rule ->> ''archived_at'', '''') is not null
               or (v_from is not null and v_from > now() + interval ''1 day'')');
  if v_new = v_def then raise exception 'assert_booking_pricing layout changed; patch not applied'; end if;
  execute v_new;
end
$patch$;
