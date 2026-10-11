-- Gaps found by the all-tiers probe (scripts/stress-tiers-local.mjs).
--
-- 1. CRITICAL: a customer could insert a payment row straight into the payments table with status PAID for their own
--    booking (the insert policy let the booking's customer, its technician and any staff add rows). The ledger counted it,
--    so a booking could be "paid" without paying, and the invented excess could then be asked back as a refund.
--    Payments are now written by administrators (recording cash) and by the server (customer receipts, which are
--    checked first); nobody else can insert them.
-- 2. A customer could change their own accepted_terms_version from the browser and skip the terms they must accept.
--    Only accept_terms() (and administrators / the server) can set it now.
-- 3. run_no_show_lifecycle() could be run by any customer or technician. It now needs an administrator or the server.

-- 1. payments
drop policy if exists "Authorized users can insert payments" on public.payments;

-- 2. terms acceptance
do $patch$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.guard_profile_privileged_columns'::regproc) into v_def;
  if v_def not like '%accepted_terms_version%' then
    v_new := replace(v_def, E'''clock_in_timestamp'', ''email_change_temp'', ''role_version'', ''hired_at'', ''can_view_reports''',
                            E'''clock_in_timestamp'', ''email_change_temp'', ''role_version'', ''hired_at'', ''can_view_reports'',\n    ''accepted_terms_version'', ''accepted_terms_at''');
    if v_new = v_def then raise exception 'guard_profile_privileged_columns layout changed (list); patch not applied'; end if;
    v_def := v_new;
    v_new := replace(v_def, E'      if v_col = ''must_change_password'' and v_first_login_flag_clear then\n        continue;\n      end if;',
      E'      if v_col = ''must_change_password'' and v_first_login_flag_clear then\n        continue;\n      end if;\n      if v_col in (''accepted_terms_version'', ''accepted_terms_at'')\n         and coalesce(current_setting(''app.allow_terms_accept'', true), '''') = ''true''\n         and auth.uid() is not null and old.id = auth.uid() then\n        continue;\n      end if;');
    if v_new = v_def then
      -- the definition may carry Windows line endings
      v_new := regexp_replace(v_def, E'(if v_col = ''must_change_password'' and v_first_login_flag_clear then\\s+continue;\\s+end if;)',
        E'\\1\n      if v_col in (''accepted_terms_version'', ''accepted_terms_at'') and coalesce(current_setting(''app.allow_terms_accept'', true), '''') = ''true'' and auth.uid() is not null and old.id = auth.uid() then\n        continue;\n      end if;');
    end if;
    if v_new = v_def then raise exception 'guard_profile_privileged_columns layout changed (loop); patch not applied'; end if;
    execute v_new;
  end if;

  select pg_get_functiondef('public.accept_terms'::regproc) into v_def;
  if v_def not like '%app.allow_terms_accept%' then
    v_new := regexp_replace(v_def, E'(update public\\.profiles\\s+set accepted_terms_version)',
      E'perform set_config(''app.allow_terms_accept'', ''true'', true);\n  \\1');
    if v_new = v_def then raise exception 'accept_terms layout changed; patch not applied'; end if;
    execute v_new;
  end if;

  -- 3. the sweep: administrators and the server only
  select pg_get_functiondef('public.run_no_show_lifecycle'::regproc) into v_def;
  if v_def not like '%Administrator access is required%' then
    v_new := regexp_replace(v_def, E'begin\\s+v_flagged :=',
      E'begin\n  if coalesce(auth.role(), '''') in (''anon'', ''authenticated'') and not public.is_admin() then\n    raise exception ''Administrator access is required.'' using errcode = ''42501'';\n  end if;\n  v_flagged :=');
    if v_new = v_def then raise exception 'run_no_show_lifecycle layout changed; patch not applied'; end if;
    execute v_new;
  end if;
end
$patch$;

-- 4. A signed-out visitor could call clear_login_lock(email) and switch off anyone's failed-login lock, so the brute-force
--    protection could be reset between guesses. The lock is cleared by the server, or by the account's own owner once
--    they are signed in (the app does this right after a successful login).
do $patch2$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.clear_login_lock(text)'::regprocedure) into v_def;
  if v_def not like '%service_role%' then
    v_new := regexp_replace(v_def, E'begin(\\s+)update public\\.profiles',
      E'begin\\1if coalesce(auth.role(), '''') <> ''service_role'' and not exists (\n    select 1 from public.profiles me where me.id = auth.uid() and lower(me.email) = lower(btrim(coalesce(p_email, '''')))\n  ) then\n    return jsonb_build_object(''cleared'', false);\n  end if;\n\\1update public.profiles');
    if v_new = v_def then raise exception 'clear_login_lock layout changed; patch not applied'; end if;
    execute v_new;
  end if;
end
$patch2$;
