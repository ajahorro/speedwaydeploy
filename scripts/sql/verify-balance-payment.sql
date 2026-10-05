-- Scratch-database test of submit_balance_payment (master plan 3.10). Rolled back.
--   docker exec -i <db-container> psql -U postgres -v ON_ERROR_STOP=0 < scripts/sql/verify-balance-payment.sql
-- Uses the scratch customer ...c1 and its confirmed bookings ...010 (balance ₱50), ...011 (₱900) and ...004 (₱30).
begin;
-- make the suite independent of whatever earlier manual testing left in the scratch database
set local session_replication_role = replica;
update bookings set customer_id = '00000000-0000-0000-0000-0000000000c1', status = 'confirmed' where id in ('10000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000011');
delete from payments where booking_id in ('10000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000011') and notes like '%BALANCE_PAYMENT%';
set local session_replication_role = origin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;

create or replace function pg_temp.try(p_name text, p_sql text, p_expect_error text default null)
returns void language plpgsql as $$
declare v_out text;
begin
  begin
    execute p_sql into v_out;
    insert into t_results values (p_name, p_expect_error is null, coalesce(v_out, ''));
  exception when others then
    insert into t_results values (p_name, p_expect_error is not null and sqlerrm ilike '%' || p_expect_error || '%', sqlerrm);
  end;
end $$;

-- scans created by the backend (service role)
select public.register_ocr_scan_session(encode(sha256('below'::bytea),'hex'), jsonb_build_object('amount', 20, 'requiredAmount', 50, 'referenceNumber', 'REF-BELOW-0001', 'receipt_url', 'http://x/below.jpg', 'transferFee', 0), 'FOR_VERIFICATION') as scan_below \gset
select public.register_ocr_scan_session(encode(sha256('exact'::bytea),'hex'), jsonb_build_object('amount', 50, 'requiredAmount', 50, 'referenceNumber', 'REF-EXACT-0002', 'receipt_url', 'http://x/exact.jpg', 'transferFee', 0), 'FOR_VERIFICATION') as scan_exact \gset
select public.register_ocr_scan_session(encode(sha256('stale'::bytea),'hex'), jsonb_build_object('amount', 50, 'requiredAmount', 999, 'referenceNumber', 'REF-STALE-0003', 'receipt_url', 'http://x/stale.jpg'), 'FOR_VERIFICATION') as scan_stale \gset
select public.register_ocr_scan_session(encode(sha256('over'::bytea),'hex'), jsonb_build_object('amount', 80, 'requiredAmount', 50, 'referenceNumber', 'REF-OVER-0004', 'receipt_url', 'http://x/over.jpg'), 'FOR_VERIFICATION') as scan_over \gset
select public.register_ocr_scan_session(encode(sha256('dup'::bytea),'hex'), jsonb_build_object('amount', 50, 'requiredAmount', 50, 'referenceNumber', 'REF-EXACT-0002', 'receipt_url', 'http://x/dup.jpg'), 'FOR_VERIFICATION') as scan_dup \gset
select public.register_ocr_scan_session(encode(sha256('manual'::bytea),'hex'), jsonb_build_object('amount', null, 'requiredAmount', 30, 'extraction_unavailable', true, 'receipt_url', 'http://x/manual.jpg'), 'FOR_VERIFICATION') as scan_manual \gset

select public.register_ocr_scan_session(encode(sha256('over900'::bytea),'hex'), jsonb_build_object('amount', 950, 'requiredAmount', 900, 'referenceNumber', 'REF-OVER-9004', 'receipt_url', 'http://x/o.jpg', 'transferFee', 15), 'FOR_VERIFICATION') as scan_over900 \gset
select public.register_ocr_scan_session(encode(sha256('dup900'::bytea),'hex'), jsonb_build_object('amount', 900, 'requiredAmount', 900, 'referenceNumber', 'REF-EXACT-0002', 'receipt_url', 'http://x/d.jpg'), 'FOR_VERIFICATION') as scan_dup900 \gset

-- other customer cannot pay someone else's booking
select set_config('request.jwt.claims', json_build_object('sub', '148c3f58-9221-4a31-abf1-8f6713b2a629', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.try('another customer is refused', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000010', :'scan_exact'), 'Booking not found');
reset role;

select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.try('receipt below the balance is refused', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000010', :'scan_below'), 'less than the balance');
select pg_temp.try('scan made for a different balance is refused', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000010', :'scan_stale'), 'balance changed');
select pg_temp.try('unknown scan is refused', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000010', gen_random_uuid()), 'missing, expired');
select pg_temp.try('exact balance is accepted', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000010', :'scan_exact'));
select pg_temp.try('the same scan cannot be used twice', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000010', :'scan_exact'), 'no balance left');
select pg_temp.try('balance already covered by the pending payment is refused', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000010', :'scan_over'), 'no balance left');
select pg_temp.try('a reference already used elsewhere is refused', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000011', :'scan_dup900'), 'already been used');
select pg_temp.try('more than the balance is accepted (excess handled by the ledger)', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000011', :'scan_over900'));
select pg_temp.try('a manual-review receipt is accepted', format('select public.submit_balance_payment(%L, %L)::text', '10000000-0000-0000-0000-000000000004', :'scan_manual'), null);
reset role;

insert into t_results
select 'the payment awaits verification, not counted as money', count(*) = 1 and bool_and(status = 'FOR_VERIFICATION'), string_agg(amount::text || '/' || coalesce(detected_amount::text, ''), ',')
  from public.payments where booking_id = '10000000-0000-0000-0000-000000000010' and notes like '%BALANCE_PAYMENT%';
insert into t_results
select 'ledger shows it as pending verification', pending_verification = 50 and submitted_balance_due = 0, 'pending=' || pending_verification || ' due=' || submitted_balance_due
  from public.booking_ledger_v where booking_id = '10000000-0000-0000-0000-000000000010';
insert into t_results
select 'scan session is consumed and linked', not active and payment_id is not null, ''
  from public.ocr_scan_sessions where id = :'scan_exact';

\o
select name, case when ok then 'PASS' else 'FAIL' end as result, detail from t_results order by 2 desc, 1;
rollback;
