-- Business Hub propagation audit (master plan 4.5), database side.
-- For each Business Hub setting: change it, then assert that the database rule that every
-- screen, the walk-in form and the emails rely on actually follows the change.
--
-- Run on a scratch database only (it works inside a transaction and rolls back):
--   docker exec -i <db-container> psql -U postgres -v ON_ERROR_STOP=1 < scripts/sql/verify-hub-propagation.sql
-- Needs one admin profile; set the id below if yours differs.

begin;
\set admin_id '00000000-0000-0000-0000-0000000000a1'
select set_config('request.jwt.claims', json_build_object('sub', :'admin_id', 'role', 'authenticated')::text, true);

create temp table audit_results (area text, check_name text, passed boolean, detail text) on commit drop;
grant all on audit_results to authenticated;
set local role authenticated;

create or replace function pg_temp.check(p_area text, p_name text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  insert into audit_results values (p_area, p_name, coalesce(p_ok, false), p_detail);
end $$;

\o /dev/null
-- ── 1. Downpayment policy (Payment Policy tab) ─────────────────────────────
update business_config set downpayment_rate = 0.40, downpayment_high_rate = 0.60, downpayment_min_total = 500, downpayment_high_threshold = 3000;
select pg_temp.check('downpayment', 'required amount follows the standard rate', public.booking_required_downpayment(1500) = 600, public.booking_required_downpayment(1500)::text);
select pg_temp.check('downpayment', 'higher rate applies from the threshold', public.booking_required_downpayment(4000) = 2400, public.booking_required_downpayment(4000)::text);
select pg_temp.check('downpayment', 'KNOWN GAP: below the minimum total the database requires full payment', public.booking_required_downpayment(400) = 400,
  'the screens say pay in full below the minimum; the database still accepts the percentage (' || public.booking_required_downpayment(400) || ') as the work-start gate');
select pg_temp.check('downpayment', 'ledger required_downpayment follows the policy',
  (select required_downpayment = round(expected_amount * case when expected_amount >= 3000 then 0.60 else 0.40 end, 2)
     from booking_ledger_v where expected_amount > 0 limit 1), 'booking_ledger_v');

-- ── 2. Schedule rules (Schedule Rules tab) ─────────────────────────────────
-- a Monday ~10 days out at 10:00 shop time, used as the probe
create temp table probe as
select (date_trunc('day', (now() at time zone public.shop_timezone())) + interval '14 days')::date as d;
update probe set d = d + ((8 - extract(dow from d)::int) % 7)::int;   -- next Monday on/after +14d
update business_config set closed_weekdays = '{}', booking_lead_time_minutes = 5, max_advance_days = 60;
select pg_temp.check('schedule', 'open weekday is accepted',
  public.booking_schedule_violation(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, false) is null, '');
update business_config set closed_weekdays = '{1}';
select pg_temp.check('schedule', 'closed weekday is refused',
  public.booking_schedule_violation(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, false) is not null, '');
update business_config set closed_weekdays = '{}', max_advance_days = 3;
select pg_temp.check('schedule', 'advance window is enforced',
  public.booking_schedule_violation(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, false) is not null, '');
update business_config set max_advance_days = 60, booking_lead_time_minutes = 600;
select pg_temp.check('schedule', 'lead time is enforced for customers but not admins',
  public.booking_schedule_violation(now() + interval '1 hour', now() + interval '2 hours', false) is not null
  and public.booking_schedule_violation(now() + interval '1 hour', now() + interval '2 hours', true) is null, '');
update business_config set booking_lead_time_minutes = 5;

-- closures (blocked_slots)
-- closures are written by the backend with the service role
reset role;
insert into blocked_slots (block_date, reason) select d, 'audit closure' from probe;
set local role authenticated;
select pg_temp.check('closures', 'a full-day closure blocks the day',
  public.booking_schedule_violation(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, false) is not null, '');
reset role;
delete from blocked_slots where reason = 'audit closure';
set local role authenticated;
select pg_temp.check('closures', 'removing the closure reopens the day',
  public.booking_schedule_violation(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, false) is null, '');

-- opening hours (migration 20261103000003): customers must start inside them, minutes included
update business_config set opening_hour = '09:30 AM', closing_hour = '05:00 PM', is_24_7 = false;
select pg_temp.check('hours', 'a start before opening is refused for customers',
  public.booking_schedule_violation(((select d from probe)::text || ' 09:15 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 10:15 Asia/Manila')::timestamptz, false) is not null, '');
select pg_temp.check('hours', 'minutes are honoured (09:30 opening accepts 09:30)',
  public.booking_schedule_violation(((select d from probe)::text || ' 09:30 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 10:30 Asia/Manila')::timestamptz, false) is null, '');
select pg_temp.check('hours', 'a start at or after closing is refused for customers',
  public.booking_schedule_violation(((select d from probe)::text || ' 17:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 18:00 Asia/Manila')::timestamptz, false) is not null, '');
select pg_temp.check('hours', 'an admin at the desk may book outside hours',
  public.booking_schedule_violation(((select d from probe)::text || ' 22:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 23:00 Asia/Manila')::timestamptz, true) is null, '');
update business_config set is_24_7 = true;
select pg_temp.check('hours', '24/7 mode removes the limit',
  public.booking_schedule_violation(((select d from probe)::text || ' 03:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 04:00 Asia/Manila')::timestamptz, false) is null, '');

-- bay capacity ("Total Bays Available", business_config.slots_per_hour)
update business_config set is_24_7 = true, enforce_capacity = true, slots_per_hour = 3;
select pg_temp.check('bays', 'a booking within the bay limit fits an empty slot',
  public.slot_has_capacity(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, null, 3), '');
select pg_temp.check('bays', 'a booking with more vehicles than the bays is refused',
  not public.slot_has_capacity(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, null, 4), 'needs 4 bays, shop has 3');
update business_config set slots_per_hour = 5;
select pg_temp.check('bays', 'raising the bay limit lets the larger booking in',
  public.slot_has_capacity(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, null, 4), '');
update business_config set slots_per_hour = 1;
select pg_temp.check('bays', 'lowering the bay limit applies immediately',
  not public.slot_has_capacity(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, null, 2), '');
update business_config set enforce_capacity = false;
select pg_temp.check('bays', 'capacity enforcement can be switched off',
  public.slot_has_capacity(((select d from probe)::text || ' 10:00 Asia/Manila')::timestamptz, ((select d from probe)::text || ' 11:00 Asia/Manila')::timestamptz, null, 9), '');
update business_config set enforce_capacity = true;

-- ── 3. Terms (Terms tab) ───────────────────────────────────────────────────
do $terms$
declare
  v_published jsonb;
  v_accepted jsonb;
  v_cfg record;
begin
  v_published := public.publish_terms('staff', 'Audit staff terms ' || now()::text);
  select terms_staff_version, terms_customer_version, terms_admin_version into v_cfg from business_config order by id limit 1;
  perform pg_temp.check('terms', 'publishing bumps the role''s version', (v_published ->> 'version')::int = v_cfg.terms_staff_version and v_cfg.terms_staff_version > 1, v_published::text);
  perform pg_temp.check('terms', 'other roles keep their version', v_cfg.terms_customer_version = 1 and v_cfg.terms_admin_version = 1, '');
  -- the audit admin accepts the ADMIN text, so the staff bump must not change what is current for them
  v_accepted := public.accept_terms();
  perform pg_temp.check('terms', 'acceptance records the current version of the account''s own role',
    (v_accepted ->> 'version')::int = (select accepted_terms_version from profiles where id = '00000000-0000-0000-0000-0000000000a1'), v_accepted::text);
end
$terms$;

-- ── 4. Promo codes (Promos tab) ────────────────────────────────────────────
insert into promo_codes (code, name, discount_type, discount_value) values ('AUDIT10', 'Audit promo', 'percentage', 10);
select pg_temp.check('promo codes', 'a created code redeems', (public.redeem_promo_code('audit10') ->> 'valid')::boolean, '');
delete from promo_codes where code = 'AUDIT10';
select pg_temp.check('promo codes', 'a deleted code no longer redeems', not coalesce((public.redeem_promo_code('AUDIT10') ->> 'valid')::boolean, false), '');

\o
-- ── result ──
select area, check_name, case when passed then 'PASS' else 'FAIL' end as result, detail from audit_results order by 3 desc, 1;
select count(*) filter (where not passed) as failures from audit_results;
rollback;
