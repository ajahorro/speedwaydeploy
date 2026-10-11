-- Three tightenings.
--
-- 1. Helper functions that answer questions about ONE booking, payment or vehicle (amount paid, photo state, receipt
--    verdict, who the technician is...) could be asked about any id by any signed-in user. They now answer only for the
--    booking's own customer, staff and administrators (and for the server); anyone else gets nothing.
--    How: each function moves to the "internal" schema (not exposed by the API; row-level-security rules and triggers
--    keep using it, unchanged) and a guarded function with the same name and signature takes its place in "public".
-- 2. Technicians no longer read payment rows, and no longer read every customer's contact details: they read colleagues
--    and administrators, and the customers of the bookings they are assigned to (their jobs). Reports for technicians
--    are the existing no-money, no-contact report switched on per technician (can_view_reports).
-- 3. Failed-login lock-out. The old counters could not even be written (the profile guard refused the update, so no
--    lock was ever applied) and were kept per account, so they could not be made to work safely: anyone could lock any
--    account. Failures are now counted per account AND per visitor address: one address can lock only itself out of that
--    account, never the owner. A spread-out attack (five or more different addresses within an hour) puts a short hold
--    on the account. A security notice is emailed at most once every six hours.

create schema if not exists internal;
grant usage on schema internal to anon, authenticated, service_role;

-- ── 1. who may ask about a booking ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.caller_may_read_booking(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.role() = 'anon' then false
    when auth.uid() is null then true  -- the server, a scheduled job, a database session
    else exists (select 1 from public.profiles me where me.id = auth.uid() and coalesce(me.is_active, true) and upper(coalesce(me.role, '')) in ('ADMIN', 'STAFF'))
      or exists (select 1 from public.bookings b where b.id = p_booking_id and b.customer_id = auth.uid())
  end
$$;

create or replace function public.caller_may_read_payment(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.caller_may_read_booking((select booking_id from public.payments where id = p_payment_id))
$$;

create or replace function public.caller_may_read_vehicle(p_vehicle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.caller_may_read_booking((select booking_id from public.booking_vehicles where id = p_vehicle_id))
$$;

do $wrap$
declare
  spec record;
  fn record;
  v_names text[];
  v_call text;
  v_guard text;
  v_vol text;
begin
  for spec in
    select * from (values
      ('booking_bay_usage', 'booking'), ('booking_evidence_state', 'booking'), ('booking_has_photo_phase', 'booking'),
      ('booking_is_fully_paid', 'booking'), ('booking_net_paid', 'booking'), ('booking_start_time_reached', 'booking'),
      ('booking_verified_paid', 'booking'), ('staff_booking_has_verified_downpayment', 'booking'), ('staff_on_booking', 'booking'),
      ('staff_can_see_photo', 'booking'), ('get_customer_booking_technician', 'booking'),
      ('booking_total_changed_since_ocr', 'payment'), ('payment_ocr_verdict', 'payment'),
      ('vehicle_has_photo_phase', 'vehicle'), ('vehicle_technician', 'vehicle')
    ) as t(name, kind)
  loop
    select p.oid, p.proname,
           pg_get_function_arguments(p.oid) as args,
           pg_get_function_identity_arguments(p.oid) as ident,
           pg_get_function_result(p.oid) as result,
           p.provolatile, p.proargnames
      into fn
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = spec.name and p.prokind = 'f'
     limit 1;
    if fn.oid is null then raise notice 'skipped %: not found', spec.name; continue; end if;
    if exists (select 1 from pg_proc p2 where p2.pronamespace = 'internal'::regnamespace and p2.proname = spec.name) then
      raise notice 'skipped %: already guarded', spec.name; continue;
    end if;

    v_names := fn.proargnames;
    v_call := (select string_agg(quote_ident(n), ', ' order by o) from unnest(v_names) with ordinality as a(n, o));
    v_guard := format('public.caller_may_read_%s(%s)', spec.kind, quote_ident(v_names[1]));
    v_vol := case fn.provolatile when 'i' then 'stable' when 's' then 'stable' else 'volatile' end;

    execute format('alter function public.%I(%s) set schema internal', spec.name, fn.ident);
    execute format(
      'create function public.%I(%s) returns %s language sql %s security definer set search_path = public as $f$ select case when %s then internal.%I(%s) end $f$',
      spec.name, fn.args, fn.result, v_vol, v_guard, spec.name, v_call);
    execute format('revoke all on function public.%I(%s) from public, anon', spec.name, fn.ident);
    execute format('grant execute on function public.%I(%s) to authenticated, service_role', spec.name, fn.ident);
  end loop;
end
$wrap$;

-- a technician's current jobs are the server's business (the app asks for its own through my_clock_out_blockers)
revoke all on function public.staff_clock_out_blockers(uuid) from public, anon, authenticated;
grant execute on function public.staff_clock_out_blockers(uuid) to service_role;

-- ── 2. technicians: no payment rows, no customer contact details beyond their own jobs ───────────────────────────────
drop policy if exists "Users can view own payments" on public.payments;
create policy payments_select_owner_or_admin on public.payments for select to authenticated
  using (
    (select public.is_admin())
    or exists (select 1 from public.bookings b where b.id = payments.booking_id and b.customer_id = (select auth.uid()))
  );

drop policy if exists "Allow users and staff to read profiles" on public.profiles;
drop policy if exists profiles_select_staff_scope on public.profiles;
create policy profiles_select_staff_scope on public.profiles for select to authenticated
  using (
    (select public.is_admin_or_staff())
    and (
      upper(coalesce(role, '')) in ('ADMIN', 'STAFF')
      or exists (
        select 1 from public.bookings b
         where b.customer_id = profiles.id
           and (b.staff_id = (select auth.uid()) or exists (select 1 from public.booking_vehicles bv where bv.booking_id = b.id and bv.staff_id = (select auth.uid())))
      )
    )
  );

-- ── 3. failed-login lock-out: per account and per visitor address ────────────────────────────────────────────────────
create table if not exists public.login_throttle (
  email text not null,
  client_key text not null,
  stage integer not null default 0,
  stage_failed integer not null default 0,
  locked_until timestamptz,
  last_failed_at timestamptz not null default now(),
  primary key (email, client_key)
);
alter table public.login_throttle enable row level security;
revoke all on public.login_throttle from anon, authenticated;
grant all on public.login_throttle to service_role;

-- the visitor's address as the platform's edge reports it (not a header the visitor can simply invent), hashed
create or replace function public.login_client_key()
returns text
language plpgsql
stable
as $$
declare
  v_headers json;
  v_xff text;
  v_ip text;
begin
  begin
    v_headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  exception when others then
    v_headers := '{}'::json;
  end;
  v_xff := nullif(v_headers ->> 'x-forwarded-for', '');
  v_ip := coalesce(
    nullif(v_headers ->> 'cf-connecting-ip', ''),
    nullif(v_headers ->> 'x-real-ip', ''),
    case when v_xff is not null then trim((regexp_split_to_array(v_xff, '\s*,\s*'))[array_length(regexp_split_to_array(v_xff, '\s*,\s*'), 1)]) end,
    'direct'
  );
  return md5('speedway-login:' || v_ip);
end;
$$;

-- the profile guard lets the lock-out functions (and only they) write the two protected counters
do $patch$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.guard_profile_privileged_columns'::regproc) into v_def;
  if v_def not like '%app.allow_lockout_write%' then
    v_new := regexp_replace(v_def, 'foreach v_col in array v_protected loop',
      E'foreach v_col in array v_protected loop\n    if coalesce(current_setting(''app.allow_lockout_write'', true), '''') = ''true'' and v_col in (''failed_login_attempts'', ''locked_until'') then\n      continue;\n    end if;');
    if v_new = v_def then raise exception 'guard_profile_privileged_columns layout changed; patch not applied'; end if;
    execute v_new;
  end if;
end
$patch$;

create or replace function public.register_failed_login_staged(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_key text := public.login_client_key();
  v_id uuid;
  v_notice_sent_at timestamptz;
  v_account_locked_until timestamptz;
  t public.login_throttle%rowtype;
  v_rung public.login_lockout_policy%rowtype;
  v_next public.login_lockout_policy%rowtype;
  v_locked_until timestamptz;
  v_notice boolean := false;
  v_addresses integer;
begin
  perform pg_advisory_xact_lock(hashtext('speedway:loginlock:' || v_email));
  perform set_config('app.allow_lockout_write', 'true', true);

  select id, security_notice_sent_at, locked_until into v_id, v_notice_sent_at, v_account_locked_until
    from public.profiles where lower(email) = v_email limit 1;

  -- unknown address: the same neutral answer as a known, unlocked one
  if v_id is null then
    return jsonb_build_object('locked', false, 'stage', 0, 'attempts_remaining', 4, 'locked_until', null, 'escalated', false);
  end if;

  insert into public.login_throttle (email, client_key) values (v_email, v_key) on conflict do nothing;
  select * into t from public.login_throttle where email = v_email and client_key = v_key for update;

  -- a hold already in force (this address, or the whole account) is reported, not extended
  if t.locked_until is not null and now() < t.locked_until then
    return jsonb_build_object('locked', true, 'stage', t.stage, 'attempts_remaining', 0, 'locked_until', t.locked_until,
      'minutes_left', ceil(extract(epoch from (t.locked_until - now())) / 60.0)::int, 'escalated', false);
  end if;
  if v_account_locked_until is not null and now() < v_account_locked_until then
    return jsonb_build_object('locked', true, 'stage', t.stage, 'attempts_remaining', 0, 'locked_until', v_account_locked_until,
      'minutes_left', ceil(extract(epoch from (v_account_locked_until - now())) / 60.0)::int, 'escalated', false);
  end if;

  -- a quiet hour starts the ladder again for this address
  if t.last_failed_at < now() - interval '1 hour' then
    t.stage := 0; t.stage_failed := 0;
  end if;

  select * into v_rung from public.login_lockout_policy where stage = t.stage;
  if not found then
    select * into v_rung from public.login_lockout_policy order by stage desc limit 1;
    t.stage := coalesce(v_rung.stage, t.stage);
  end if;
  t.stage_failed := t.stage_failed + 1;

  if t.stage_failed > coalesce(v_rung.attempts_allowed, 0) then
    t.stage := t.stage + 1;
    t.stage_failed := 0;
    select * into v_rung from public.login_lockout_policy where stage = t.stage;
    if not found then
      select * into v_rung from public.login_lockout_policy order by stage desc limit 1;
      t.stage := coalesce(v_rung.stage, t.stage);
    end if;

    if coalesce(v_rung.escalate, false) then
      v_locked_until := now() + interval '60 minutes';
      update public.login_throttle set stage = t.stage, stage_failed = 0, locked_until = v_locked_until, last_failed_at = now()
       where email = v_email and client_key = v_key;
      -- the owner is told, but at most once every six hours however many addresses keep trying
      if v_notice_sent_at is null or v_notice_sent_at < now() - interval '6 hours' then
        insert into public.login_security_notices (user_id, email, reason, attempts_at_escalation)
        values (v_id, (select email from public.profiles where id = v_id), 'REPEATED_FAILED_LOGIN', t.stage_failed);
        update public.profiles set security_notice_sent_at = now() where id = v_id;
        v_notice := true;
      end if;
      return jsonb_build_object('locked', true, 'stage', t.stage, 'attempts_remaining', 0, 'locked_until', v_locked_until, 'minutes_left', 60,
        'escalated', true, 'notice_queued', v_notice,
        'message', 'Too many incorrect attempts. A security notice with a password-reset link has been sent to the account email address.');
    end if;

    v_locked_until := now() + make_interval(mins => coalesce(v_rung.lock_minutes, 5));
    update public.login_throttle set stage = t.stage, stage_failed = 0, locked_until = v_locked_until, last_failed_at = now()
     where email = v_email and client_key = v_key;
    select * into v_next from public.login_lockout_policy where stage = t.stage + 1;
    return jsonb_build_object('locked', true, 'stage', t.stage, 'attempts_remaining', 0, 'locked_until', v_locked_until,
      'minutes_left', coalesce(v_rung.lock_minutes, 5), 'escalated', false,
      'next_stage_attempts_allowed', coalesce(v_next.attempts_allowed, 1), 'next_stage_lock_minutes', v_next.lock_minutes,
      'next_stage_escalates', coalesce(v_next.escalate, true));
  end if;

  update public.login_throttle set stage = t.stage, stage_failed = t.stage_failed, last_failed_at = now(), locked_until = null
   where email = v_email and client_key = v_key;

  -- a spread-out attack (many different addresses) holds the account briefly
  select count(*) into v_addresses from public.login_throttle
   where email = v_email and last_failed_at > now() - interval '1 hour' and (stage > 0 or stage_failed > 0);
  if v_addresses >= 5 then
    v_locked_until := now() + interval '15 minutes';
    update public.profiles set locked_until = v_locked_until, failed_login_attempts = 0 where id = v_id;
    return jsonb_build_object('locked', true, 'stage', t.stage, 'attempts_remaining', 0, 'locked_until', v_locked_until, 'minutes_left', 15, 'escalated', false);
  end if;

  return jsonb_build_object('locked', false, 'stage', t.stage, 'attempts_remaining', coalesce(v_rung.attempts_allowed, 0) - t.stage_failed,
    'locked_until', null, 'escalated', false);
end;
$$;

create or replace function public.check_login_lock(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_key text := public.login_client_key();
  t public.login_throttle%rowtype;
  p record;
  v_until timestamptz;
  v_locked boolean;
  v_rung public.login_lockout_policy%rowtype;
begin
  select coalesce(must_change_password, false) as must_change, locked_until, security_notice_sent_at into p
    from public.profiles where lower(email) = v_email limit 1;
  select * into t from public.login_throttle where email = v_email and client_key = v_key;
  if t.last_failed_at is not null and t.last_failed_at < now() - interval '1 hour' and (t.locked_until is null or t.locked_until < now()) then
    t.stage := 0; t.stage_failed := 0;
  end if;
  v_until := greatest(coalesce(t.locked_until, '-infinity'), coalesce(p.locked_until, '-infinity'));
  v_locked := v_until > now();
  select * into v_rung from public.login_lockout_policy where stage = coalesce(t.stage, 0);
  return jsonb_build_object(
    'locked', v_locked,
    'locked_until', case when v_locked then v_until end,
    'seconds_left', case when v_locked then ceil(extract(epoch from (v_until - now())))::int else 0 end,
    'minutes_left', case when v_locked then ceil(extract(epoch from (v_until - now())) / 60.0)::int else 0 end,
    'failed_login_attempts', coalesce(t.stage_failed, 0),
    'must_change_password', coalesce(p.must_change, false),
    'stage', coalesce(t.stage, 0),
    'attempts_remaining', case when v_locked then 0 else greatest(0, coalesce(v_rung.attempts_allowed, 4) - coalesce(t.stage_failed, 0)) end,
    'security_notice_sent', p.security_notice_sent_at is not null and v_locked,
    'next_lock_minutes', v_rung.lock_minutes,
    'escalates_next', coalesce(v_rung.escalate, false)
  );
end;
$$;

create or replace function public.clear_login_lock(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  -- the server, or the account's own owner once signed in (the app does this right after a successful login)
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from public.profiles me where me.id = auth.uid() and lower(me.email) = v_email
  ) then
    return jsonb_build_object('cleared', false);
  end if;
  perform set_config('app.allow_lockout_write', 'true', true);
  delete from public.login_throttle where email = v_email;
  update public.profiles
     set failed_login_attempts = 0, locked_until = null, lockout_stage = 0, stage_failed_attempts = 0,
         security_notice_sent_at = null, updated_at = now()
   where lower(email) = v_email;
  return jsonb_build_object('cleared', true);
end;
$$;

revoke all on function public.register_failed_login_staged(text) from public;
grant execute on function public.register_failed_login_staged(text) to anon, authenticated, service_role;
revoke all on function public.check_login_lock(text) from public;
grant execute on function public.check_login_lock(text) to anon, authenticated, service_role;
revoke all on function public.clear_login_lock(text) from public;
grant execute on function public.clear_login_lock(text) to anon, authenticated, service_role;
revoke all on function public.login_client_key() from public, anon, authenticated;
