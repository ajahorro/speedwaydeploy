-- ============================================================================
-- Supabase Security / Performance Advisor, batch 2.
--
-- 1. RLS policies that were "always true" and let ANY signed-in user write:
--      business_config UPDATE (any customer could rewrite the shop config)
--      audit_logs INSERT      (any user could forge audit rows)
--    Both already have a correct admin / self-or-admin policy next to them, so
--    the open policy is dropped. booking_messages UPDATE had WITH CHECK (true);
--    it now re-checks participation. pending_registrations INSERT stays open on
--    purpose (guest registration before an account exists).
--
-- 2. Multiple permissive policies: exact duplicates on business_config removed.
--
-- 3. Auth RLS initplan: auth.uid()/auth.role()/auth.jwt() inside a policy is
--    re-evaluated per row. Wrapping it as (select auth.uid()) evaluates once.
--    Every policy in public is rewritten mechanically; the meaning is identical.
--
-- 4. Duplicate indexes: identical indexes on the same table are dropped, keeping
--    the one that backs a constraint (or the oldest).
--
-- 5. SECURITY DEFINER functions were executable by anon/public and by signed-in
--    users. Server-only functions (called with the service key by the backend or
--    Edge Functions, never by the browser) are now service_role only, and the
--    pre-login set for anon is an explicit short list. RLS helper functions
--    stay executable because policies call them. debug_function_source is removed.
--
-- 6. Storage: the public buckets had broad SELECT policies that let anyone
--    LIST every file. Public URLs do not need them, so they are removed. The
--    open anonymous upload to payment-receipts is limited to signed-in users.
--
-- Leaked-password protection is a Dashboard setting (Authentication > Password
-- security); it cannot be changed from SQL.
-- ============================================================================

-- ── 1 & 2. Policies ─────────────────────────────────────────────────────────
drop policy if exists "Allow authenticated updates on business_config" on public.business_config;
drop policy if exists "business_config_select_authenticated" on public.business_config;  -- duplicate of "Allow public read access"
drop policy if exists "business_config_insert_admin" on public.business_config;          -- duplicate of business_config_upsert_admin
drop policy if exists "Authenticated users can insert audit logs" on public.audit_logs;  -- audit_logs_insert_self_or_admin remains

drop policy if exists "Participants can update their booking messages" on public.booking_messages;
create policy "Participants can update their booking messages"
  on public.booking_messages
  for update
  to authenticated
  using (public.can_access_booking_message(customer_id, sender_id))
  with check (public.can_access_booking_message(customer_id, sender_id));

-- ── 3. Auth RLS initplan ────────────────────────────────────────────────────
do $$
declare
  pol record;
  v_using text;
  v_check text;
  v_changed boolean;
  v_sql text;
begin
  for pol in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
  loop
    v_using := pol.qual;
    v_check := pol.with_check;
    v_changed := false;

    if v_using is not null then
      v_using := regexp_replace(v_using, '(?<!SELECT )auth\.(uid|role|jwt)\(\)', '(select auth.\1())', 'g');
      v_changed := v_changed or v_using <> pol.qual;
    end if;
    if v_check is not null then
      v_check := regexp_replace(v_check, '(?<!SELECT )auth\.(uid|role|jwt)\(\)', '(select auth.\1())', 'g');
      v_changed := v_changed or v_check <> pol.with_check;
    end if;

    if v_changed then
      v_sql := format('alter policy %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
      if v_using is not null then v_sql := v_sql || format(' using (%s)', v_using); end if;
      if v_check is not null then v_sql := v_sql || format(' with check (%s)', v_check); end if;
      execute v_sql;
    end if;
  end loop;
end $$;

-- ── 4. Duplicate indexes ────────────────────────────────────────────────────
do $$
declare
  grp record;
  idx record;
begin
  for grp in
    select array_agg(i.indexrelid order by
             (exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)) desc,
             i.indexrelid) as ids
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
     group by i.indrelid, i.indkey::text, i.indclass::text, i.indoption::text,
              coalesce(pg_get_expr(i.indpred, i.indrelid), ''),
              coalesce(pg_get_expr(i.indexprs, i.indrelid), ''),
              i.indisunique
    having count(*) > 1
  loop
    -- ids[1] is kept (constraint-backed first, then oldest); the rest go.
    for idx in
      select u.id as indexrelid
        from unnest(grp.ids[2:array_length(grp.ids, 1)]) as u(id)
       where not exists (select 1 from pg_constraint c where c.conindid = u.id)
    loop
      execute format('drop index if exists %s', idx.indexrelid::regclass);
    end loop;
  end loop;
end $$;

-- ── 5. Function privileges ──────────────────────────────────────────────────
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'debug_function_source'
  loop
    execute format('drop function %s', fn.sig);
  end loop;
end $$;

do $$
declare
  fn record;
begin
  -- Nobody but the server needs these. Invoker-rights code does not call them.
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and p.proname in (
         'admin_cancel_booking', 'admin_override_payment_to_paid', 'apply_service_downpayment',
         'archive_stale_service_photos', 'claim_booking_email', 'claim_login_security_notices',
         'close_expired_no_show_windows', 'create_booking_atomic', 'create_invited_account',
         'customer_excess_credit', 'deactivate_customer_account', 'delete_booking_cascade',
         'elevate_profile_role', 'flag_no_show_bookings', 'lock_schedule_day',
         'manage_user_status', 'mutate_booking_locked', 'persist_ocr_result',
         'process_booking_refund', 'process_overpayment_credit_refund',
         'purge_stale_service_photos', 'reconcile_booking_excess_credit',
         'record_booking_email_result', 'record_excess_credit', 'record_failed_login',
         'register_ocr_scan_session', 'release_booking_email_claim',
         'release_expired_unpaid_holds', 'resolve_customer_by_email',
         'revoke_staff_access', 'run_service_photo_retention', 'set_promo_rules',
         'undo_no_show', 'exec_sql', 'get_policies', 'staff_has_active_services'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;

  -- Everything else that is SECURITY DEFINER: anon gets only the pre-login set.
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and p.prosecdef
       and p.prorettype <> 'trigger'::regtype
       and p.proname not in (
         -- pre-login flows
         'check_login_lock', 'clear_login_lock', 'register_failed_login',
         'register_failed_login_staged', 'recover_account',
         -- RLS helpers: policies that apply to anon evaluate these
         'is_admin', 'is_admin_or_staff', 'is_staff_or_admin', 'is_privileged_caller',
         'get_my_role', 'can_access_booking_message', 'staff_booking_has_verified_downpayment',
         'default_admin_id'
       )
       and p.proname not in (
         'admin_cancel_booking', 'admin_override_payment_to_paid', 'apply_service_downpayment',
         'archive_stale_service_photos', 'claim_booking_email', 'claim_login_security_notices',
         'close_expired_no_show_windows', 'create_booking_atomic', 'create_invited_account',
         'customer_excess_credit', 'deactivate_customer_account', 'delete_booking_cascade',
         'elevate_profile_role', 'flag_no_show_bookings', 'lock_schedule_day',
         'manage_user_status', 'mutate_booking_locked', 'persist_ocr_result',
         'process_booking_refund', 'process_overpayment_credit_refund',
         'purge_stale_service_photos', 'reconcile_booking_excess_credit',
         'record_booking_email_result', 'record_excess_credit', 'record_failed_login',
         'register_ocr_scan_session', 'release_booking_email_claim',
         'release_expired_unpaid_holds', 'resolve_customer_by_email',
         'revoke_staff_access', 'run_service_photo_retention', 'set_promo_rules',
         'undo_no_show', 'exec_sql', 'get_policies', 'staff_has_active_services'
       )
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated, service_role', fn.sig);
  end loop;
end $$;

-- ── 6. Storage: no public listing, no anonymous upload ─────────────────────
do $$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists "Anyone can view chat media" on storage.objects;
    drop policy if exists "Anyone can view receipts" on storage.objects;
    drop policy if exists "Public Access" on storage.objects;
    drop policy if exists "Public Upload" on storage.objects;

    if not exists (select 1 from pg_policies
                    where schemaname = 'storage' and tablename = 'objects'
                      and policyname = 'Authenticated users can upload payment receipts') then
      create policy "Authenticated users can upload payment receipts"
        on storage.objects
        for insert
        to authenticated
        with check (bucket_id = 'payment-receipts');
    end if;
  end if;
end $$;
