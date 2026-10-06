-- Scratch-database test of the "book for customer" invitation. Rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;
select id as cu from public.profiles where role = 'CUSTOMER' and coalesce(is_active, true) order by created_at limit 1 \gset
select id as cu2 from public.profiles where role = 'CUSTOMER' and coalesce(is_active, true) and id <> :'cu' order by created_at limit 1 \gset
select id as ad from public.profiles where role = 'ADMIN' order by created_at limit 1 \gset
select id as st from public.profiles where role = 'STAFF' order by created_at limit 1 \gset

create or replace function pg_temp.as_user(p_id uuid) returns void language sql as
$$ select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.try(p_name text, p_sql text, p_expect_error text default null)
returns void language plpgsql as $$
declare v_out text;
begin
  begin
    execute p_sql into v_out;
    insert into t_results values (p_name, p_expect_error is null, left(coalesce(v_out, ''), 80));
  exception when others then
    insert into t_results values (p_name, p_expect_error is not null and sqlerrm ilike '%' || p_expect_error || '%', sqlerrm);
  end;
end $$;

set local role authenticated;
select pg_temp.as_user(:'cu');
select pg_temp.try('a customer cannot send an invitation', format('select public.send_booking_draft_invite(%L)', :'cu'), 'Only an administrator');
select pg_temp.as_user(:'st');
select pg_temp.try('staff cannot send an invitation', format('select public.send_booking_draft_invite(%L)', :'cu'), 'Only an administrator');
select pg_temp.as_user(:'ad');
select pg_temp.try('administrator cannot invite a non-customer', format('select public.send_booking_draft_invite(%L)', :'st'), 'active account');
select public.send_booking_draft_invite(:'cu') as inv \gset
select pg_temp.try('the invitation appears in the chat', format($f$select (select count(*) from public.booking_messages where invite_id = %L and message_type = 'booking_invite')::text$f$, :'inv'));
select pg_temp.try('opening before the customer shares is refused', format('select public.use_booking_draft_invite(%L)', :'inv'), 'has not sent');

select pg_temp.as_user(:'cu2');
select pg_temp.try('another customer cannot share into it', format($f$select public.share_booking_draft(%L, '{"date":"2026-12-01"}'::jsonb, 2)$f$, :'inv'), 'not found');
select pg_temp.as_user(:'cu');
select pg_temp.try('the customer shares their details', format($f$select public.share_booking_draft(%L, '{"date":"2026-12-01","vehicles":[{"brand":"Toyota"}],"payment":{"method":"GCash"}}'::jsonb, 3)$f$, :'inv'));
select pg_temp.try('the same invitation cannot be used twice', format($f$select public.share_booking_draft(%L, '{"date":"2026-12-02"}'::jsonb, 1)$f$, :'inv'), 'no longer open');
select pg_temp.try('the customer cannot read other invitations', $$select (select count(*) from public.booking_draft_invites where customer_id <> auth.uid())::text$$);
select pg_temp.as_user(:'ad');
select pg_temp.try('administrator opens the details', format($f$select (public.use_booking_draft_invite(%L))::text$f$, :'inv'));
select pg_temp.try('they open only once', format('select public.use_booking_draft_invite(%L)', :'inv'), 'has not sent');
reset role;
select pg_temp.try('the payment part is not copied', format($f$select (draft ? 'payment')::text from public.booking_draft_invites where id = %L$f$, :'inv'));

select name, case when ok then 'PASS' else 'FAIL' end, detail from t_results order by 1;
rollback;
