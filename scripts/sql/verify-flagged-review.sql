-- Scratch-database test of flagged_bookings_for_review. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
set local session_replication_role = replica;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;
select id as cu from public.profiles where role = 'CUSTOMER' order by created_at limit 1 \gset
select id as ad from public.profiles where role = 'ADMIN' order by created_at limit 1 \gset
-- A: fully paid, only a retired "to be received" record is marked rejected -> NOT flagged
-- B: a customer's receipt was rejected and nothing replaced it, money still owed -> flagged (payment rejected)
-- C: a rejected receipt that was then replaced by a paid payment, fully paid -> NOT flagged
-- D: marked as needing attention -> flagged (marked)
-- E: rejected receipt but the booking is cancelled -> NOT flagged here
insert into public.bookings (id, customer_id, customer_name, status, total_amount, start_datetime, end_datetime, needs_attention) values
 ('95000000-0000-0000-0000-00000000000a', :'cu', 'A', 'confirmed', 500, now() + interval '30 days', now() + interval '30 days 1 hour', false),
 ('95000000-0000-0000-0000-00000000000b', :'cu', 'B', 'confirmed', 500, now() + interval '31 days', now() + interval '31 days 1 hour', false),
 ('95000000-0000-0000-0000-00000000000c', :'cu', 'C', 'confirmed', 500, now() + interval '32 days', now() + interval '32 days 1 hour', false),
 ('95000000-0000-0000-0000-00000000000d', :'cu', 'D', 'confirmed', 500, now() + interval '33 days', now() + interval '33 days 1 hour', true),
 ('95000000-0000-0000-0000-00000000000e', :'cu', 'E', 'cancelled', 500, now() + interval '34 days', now() + interval '34 days 1 hour', false);
insert into public.payments (booking_id, amount, method, payment_type, status, created_at) values
 ('95000000-0000-0000-0000-00000000000a', 500, 'GCash', 'Full', 'PAID', now() - interval '3 hours'),
 ('95000000-0000-0000-0000-00000000000a', 500, 'RECEIVABLE', 'Manual', 'REJECTED', now() - interval '4 hours'),
 ('95000000-0000-0000-0000-00000000000b', 500, 'GCash', 'Full', 'REJECTED', now() - interval '3 hours'),
 ('95000000-0000-0000-0000-00000000000c', 500, 'GCash', 'Full', 'REJECTED', now() - interval '5 hours'),
 ('95000000-0000-0000-0000-00000000000c', 500, 'GCash', 'Full', 'PAID', now() - interval '2 hours'),
 ('95000000-0000-0000-0000-00000000000e', 500, 'GCash', 'Full', 'REJECTED', now() - interval '3 hours');
set local session_replication_role = origin;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ad', 'role', 'authenticated')::text, true);
insert into t_results select 'a paid booking with a retired receivable record is not flagged', not exists (select 1 from public.flagged_bookings_for_review() where booking_id = '95000000-0000-0000-0000-00000000000a'), '';
insert into t_results select 'a rejected receipt with money owed is flagged as payment rejected', exists (select 1 from public.flagged_bookings_for_review() where booking_id = '95000000-0000-0000-0000-00000000000b' and reason = 'Payment rejected'), '';
insert into t_results select 'a rejected receipt that was replaced and paid is not flagged', not exists (select 1 from public.flagged_bookings_for_review() where booking_id = '95000000-0000-0000-0000-00000000000c'), '';
insert into t_results select 'a booking marked for attention is flagged', exists (select 1 from public.flagged_bookings_for_review() where booking_id = '95000000-0000-0000-0000-00000000000d' and reason = 'Marked for attention'), '';
insert into t_results select 'a cancelled booking is not flagged here', not exists (select 1 from public.flagged_bookings_for_review() where booking_id = '95000000-0000-0000-0000-00000000000e'), '';
insert into t_results select 'one row per booking', (select count(*) from public.flagged_bookings_for_review() where booking_id in (select id from public.bookings where customer_name in ('A','B','C','D','E'))) = 2, '';
select set_config('request.jwt.claims', json_build_object('sub', :'cu', 'role', 'authenticated')::text, true);
do $$
begin
  begin
    perform * from public.flagged_bookings_for_review();
    insert into t_results values ('a customer is refused', false, 'allowed');
  exception when others then
    insert into t_results values ('a customer is refused', true, sqlerrm);
  end;
end $$;
reset role;

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
