-- ============================================================================
-- Batch 7 / Step 7.5 -- Task B: QR security, OCR net-credit & overpayment ledger
-- ============================================================================
--
-- Adds, in one guarded/idempotent migration:
--
--   1. BUSINESS HUB QR SECURITY
--      * Four MANDATORY recipient fields on business_config:
--          qr_account_name, qr_account_number,
--          fallback_receiver_name, fallback_receiver_number
--        plus a NOT NULL/empty CHECK so a half-configured QR can never be saved.
--      * qr_config_version     : monotonic counter bumped on every QR change.
--      * qr_updated_at         : timestamp of the last commit.
--
--   2. MID-UPDATE CONCURRENCY FALLBACK
--      * bookings.active_qr_snapshot (jsonb): captured at checkout start, so a
--        customer already paying against QR v1 keeps paying against v1 even if an
--        admin swaps the QR mid-flight. The snapshot is the authoritative target
--        for that session.
--
--   3. OTP VERIFICATION (6-digit email code) for QR changes
--      * qr_change_otp table: pending OTP challenges, hashed, single-use, TTL.
--      * request_qr_change_otp(...) / verify_qr_change_otp(...) RPCs.
--
--   4. OCR NET-CREDIT + OVERPAYMENT LEDGER
--      * payments.transfer_fee + payments.net_credit columns.
--        Net Payment Credit = Total Deducted - Transfer Fee (GoTyme / cross-bank).
--      * customer_credit_ledger table: running excess_credit per customer.
--      * apply_service_downpayment(...) : auto-absorb excess_credit against a
--        downpayment D, charging only max(0, D - excess_credit).
--      * settle_overpayment_on_completion(...) : routes leftover excess_credit
--        to the Refund Hub queue when a booking flips to COMPLETED.
--
-- All statements are guarded so the file is safe to re-run.
-- ============================================================================

-- -- 1. Business config: mandated QR recipient fields + versioning ------------
alter table if exists public.business_config
  add column if not exists qr_account_name text default '',
  add column if not exists qr_account_number text default '',
  add column if not exists fallback_receiver_name text default '',
  add column if not exists fallback_receiver_number text default '',
  add column if not exists qr_config_version integer not null default 1,
  add column if not exists qr_updated_at timestamptz;

-- Backfill empty strings for pre-existing NULLs so the NOT-BLANK check passes
-- on rows created before these columns existed.
update public.business_config set qr_account_name = '' where qr_account_name is null;
update public.business_config set qr_account_number = '' where qr_account_number is null;
update public.business_config set fallback_receiver_name = '' where fallback_receiver_name is null;
update public.business_config set fallback_receiver_number = '' where fallback_receiver_number is null;
update public.business_config set qr_config_version = 1 where qr_config_version is null;

-- Completion guard: when a row is marked configured it must have all four
-- fields non-blank. Uses a single boolean `qr_config_complete` flag the app sets
-- only after the OTP-verified flow succeeds, so a draft save is still possible.
alter table if exists public.business_config
  add column if not exists qr_config_complete boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_config_qr_recipients_complete') then
    alter table public.business_config
      add constraint business_config_qr_recipients_complete
      check (
        qr_config_complete = false
        or (
          length(btrim(qr_account_name)) > 0
          and length(btrim(qr_account_number)) > 0
          and length(btrim(fallback_receiver_name)) > 0
          and length(btrim(fallback_receiver_number)) > 0
        )
      );
  end if;
end $$;

comment on column public.business_config.qr_account_name is
  'Task B: mandatory primary QR recipient account name.';
comment on column public.business_config.qr_config_version is
  'Task B: monotonic version bumped on each verified QR change; used for snapshots.';

-- -- 2. Booking checkout QR snapshot (mid-update fallback) --------------------
alter table if exists public.bookings
  add column if not exists active_qr_snapshot jsonb,
  add column if not exists qr_snapshot_version integer;

comment on column public.bookings.active_qr_snapshot is
  'Task B: QR recipient snapshot captured when the checkout session started. Mid-update QR changes do not fail an in-flight payment because it settles against this frozen target.';

-- -- 3. Admin predicate (defined BEFORE any policy that references it) --------
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and upper(coalesce(role,'')) = 'ADMIN'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- -- 4. OTP challenges for QR changes -----------------------------------------
create table if not exists public.qr_change_otp (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id) on delete cascade,
  otp_hash text not null,
  payload jsonb not null,               -- the pending QR config to apply on success
  attempts integer not null default 0,
  consumed boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists qr_change_otp_admin_idx on public.qr_change_otp(admin_id, consumed, expires_at);

alter table public.qr_change_otp enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='qr_change_otp' and policyname='qr_change_otp_admin_all') then
    create policy qr_change_otp_admin_all on public.qr_change_otp
      for all to authenticated
      using (public.is_admin())
      with check (public.is_admin());
  end if;
end $$;

-- -- 5. Payments: transfer-fee + net-credit columns ---------------------------
alter table if exists public.payments
  add column if not exists transfer_fee numeric not null default 0,
  add column if not exists net_credit numeric,
  add column if not exists credit_applied numeric not null default 0,
  add column if not exists excess_routed numeric not null default 0;

comment on column public.payments.net_credit is
  'Task B: Net Payment Credit = detected/declared total - transfer_fee (GoTyme / cross-bank defense). This is the figure credited to the booking.';

-- -- 6. Customer credit ledger (excess_credit) --------------------------------
create table if not exists public.customer_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete set null,
  entry_type text not null check (entry_type in ('EXCESS', 'ABSORBED', 'REFUND_QUEUED', 'ADJUSTMENT')),
  amount numeric not null,              -- signed: + credit in, - credit consumed
  balance_after numeric not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists customer_credit_ledger_customer_idx
  on public.customer_credit_ledger(customer_id, created_at desc);

alter table public.customer_credit_ledger enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='customer_credit_ledger' and policyname='credit_ledger_owner_read') then
    create policy credit_ledger_owner_read on public.customer_credit_ledger
      for select to authenticated using (customer_id = auth.uid() or public.is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename='customer_credit_ledger' and policyname='credit_ledger_admin_write') then
    create policy credit_ledger_admin_write on public.customer_credit_ledger
      for all to authenticated using (public.is_admin()) with check (public.is_admin());
  end if;
end $$;

-- Convenience: the live excess_credit balance for a customer (sum of entries).
create or replace function public.customer_excess_credit(p_customer_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(amount), 0)::numeric
    from public.customer_credit_ledger
   where customer_id = p_customer_id;
$$;

-- -- 6. apply_service_downpayment: absorb excess_credit against D -------------
-- Given a required downpayment D, consume any available excess_credit first and
-- return the NET SHORTFALL the customer must actually pay.
--   * D <= excess_credit  -> shortfall 0, absorb D from the ledger.
--   * D  > excess_credit  -> absorb all credit, shortfall = D - excess_credit.
create or replace function public.apply_service_downpayment(
  p_customer_id uuid,
  p_booking_id uuid,
  p_downpayment numeric
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_available numeric;
  v_credit_used numeric;
  v_shortfall numeric;
  v_balance numeric;
begin
  if p_customer_id is null or p_downpayment is null or p_downpayment < 0 then
    raise exception 'A customer and a non-negative downpayment are required';
  end if;

  -- Serialize per-customer so two concurrent additions cannot double-spend credit.
  perform pg_advisory_xact_lock(hashtext('speedway:credit:' || p_customer_id::text));

  select public.customer_excess_credit(p_customer_id) into v_available;
  v_available := greatest(0, coalesce(v_available, 0));

  v_credit_used := least(p_downpayment, v_available);
  v_shortfall := greatest(0, p_downpayment - v_credit_used);
  v_balance := v_available - v_credit_used;

  if v_credit_used > 0 then
    insert into public.customer_credit_ledger
      (customer_id, booking_id, entry_type, amount, balance_after, note)
    values
      (p_customer_id, p_booking_id, 'ABSORBED', -v_credit_used, v_balance,
       'Auto-absorbed against service downpayment of ' || p_downpayment);
  end if;

  return jsonb_build_object(
    'downpayment', p_downpayment,
    'credit_available', v_available,
    'credit_used', v_credit_used,
    'shortfall', v_shortfall,
    'balance_after', v_balance
  );
end;
$$;

-- -- 7. settle_overpayment_on_completion: route leftover credit to Refund Hub -
-- Called when a booking flips to COMPLETED. Any positive excess_credit tied to
-- that booking is converted to a REFUND_QUEUED entry and the booking is marked
-- for the Refund Hub, so unused credit is never silently lost.
create or replace function public.settle_overpayment_on_completion(p_booking_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_customer uuid;
  v_excess numeric;
  v_balance numeric;
begin
  select customer_id into v_customer from public.bookings where id = p_booking_id;
  if v_customer is null then
    return jsonb_build_object('routed', 0, 'reason', 'booking not found');
  end if;

  perform pg_advisory_xact_lock(hashtext('speedway:credit:' || v_customer::text));

  select public.customer_excess_credit(v_customer) into v_excess;
  v_excess := greatest(0, coalesce(v_excess, 0));

  if v_excess <= 0 then
    return jsonb_build_object('routed', 0, 'balance_after', 0);
  end if;

  v_balance := 0; -- all remaining credit is routed out

  insert into public.customer_credit_ledger
    (customer_id, booking_id, entry_type, amount, balance_after, note)
  values
    (v_customer, p_booking_id, 'REFUND_QUEUED', -v_excess, v_balance,
     'Unused excess credit routed to Refund Hub on booking completion');

  update public.bookings
     set refund_status = coalesce(refund_status, 'QUEUED'),
         updated_at = now()
   where id = p_booking_id;

  insert into public.audit_logs
    (booking_id, action_type, details, actor_name, actor_role, metadata)
  values
    (p_booking_id, 'OVERPAYMENT_REFUND_QUEUED',
     'Unused excess credit of ' || v_excess || ' routed to Refund Hub on completion',
     'System', 'SYSTEM',
     jsonb_build_object('excess_routed', v_excess, 'balance_after', v_balance));

  return jsonb_build_object('routed', v_excess, 'balance_after', v_balance);
end;
$$;

-- -- 8. Grants ----------------------------------------------------------------
revoke all on function public.customer_excess_credit(uuid) from public;
grant execute on function public.customer_excess_credit(uuid) to authenticated;

revoke all on function public.apply_service_downpayment(uuid, uuid, numeric) from public;
grant execute on function public.apply_service_downpayment(uuid, uuid, numeric) to authenticated;

revoke all on function public.settle_overpayment_on_completion(uuid) from public;
grant execute on function public.settle_overpayment_on_completion(uuid) to authenticated;

-- -- 9. OTP RPCs --------------------------------------------------------------
-- start_qr_change_otp: admin prepares a QR change; the app emails a 6-digit code.
-- The OTP is stored HASHED (pgcrypto digest) and never returned by this function.
create or replace function public.start_qr_change_otp(
  p_payload jsonb,
  p_otp_hash text
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only administrators may change the QR configuration';
  end if;
  if p_payload is null or p_otp_hash is null or length(p_otp_hash) < 16 then
    raise exception 'A payload and a hashed OTP are required';
  end if;

  -- One live challenge per admin: supersede any earlier pending row.
  update public.qr_change_otp
     set consumed = true
   where admin_id = auth.uid() and consumed = false;

  insert into public.qr_change_otp (admin_id, otp_hash, payload, expires_at)
  values (auth.uid(), p_otp_hash, p_payload, now() + interval '5 minutes')
  returning id into v_id;

  return v_id;
end;
$$;

-- verify_qr_change_otp: checks the hash, enforces the 4 mandatory fields and
-- commits the QR config, bumping qr_config_version and writing an audit entry.
create or replace function public.verify_qr_change_otp(
  p_otp_hash text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_row public.qr_change_otp%rowtype;
  v_name text; v_num text; v_fname text; v_fnum text;
  v_new_version integer;
begin
  if not public.is_admin() then
    raise exception 'Only administrators may change the QR configuration';
  end if;

  select * into v_row
    from public.qr_change_otp
   where admin_id = auth.uid() and consumed = false
   order by created_at desc
   limit 1
   for update;

  if not found then raise exception 'No pending QR change to verify'; end if;
  if v_row.expires_at < now() then raise exception 'The verification code has expired. Please request a new one.'; end if;
  if v_row.attempts >= 5 then raise exception 'Too many incorrect codes. Please request a new one.'; end if;

  if v_row.otp_hash <> p_otp_hash then
    update public.qr_change_otp set attempts = attempts + 1 where id = v_row.id;
    raise exception 'Incorrect verification code';
  end if;

  -- Mandatory-field enforcement at the DB layer (defense in depth).
  v_name  := btrim(coalesce(v_row.payload->>'qr_account_name', ''));
  v_num   := btrim(coalesce(v_row.payload->>'qr_account_number', ''));
  v_fname := btrim(coalesce(v_row.payload->>'fallback_receiver_name', ''));
  v_fnum  := btrim(coalesce(v_row.payload->>'fallback_receiver_number', ''));
  if v_name = '' or v_num = '' or v_fname = '' or v_fnum = '' then
    raise exception 'All fields are required';
  end if;

  update public.business_config
     set qr_account_name = v_name,
         qr_account_number = v_num,
         fallback_receiver_name = v_fname,
         fallback_receiver_number = v_fnum,
         qr_config_complete = true,
         qr_config_version = coalesce(qr_config_version, 1) + 1,
         qr_updated_at = now()
   where id = (select id from public.business_config order by id limit 1)
  returning qr_config_version into v_new_version;

  update public.qr_change_otp set consumed = true where id = v_row.id;

  insert into public.audit_logs (action_type, details, actor_name, actor_role, metadata)
  values (
    'QR_CONFIG_UPDATED',
    'Business Hub QR recipients updated (OTP verified)',
    coalesce((select full_name from public.profiles where id = auth.uid()), 'Admin'),
    'ADMIN',
    jsonb_build_object(
      'old_values', jsonb_build_object(
        'qr_account_name', v_row.payload->>'old_qr_account_name',
        'qr_account_number', v_row.payload->>'old_qr_account_number',
        'fallback_receiver_name', v_row.payload->>'old_fallback_receiver_name',
        'fallback_receiver_number', v_row.payload->>'old_fallback_receiver_number'
      ),
      'new_values', jsonb_build_object(
        'qr_account_name', v_name,
        'qr_account_number', v_num,
        'fallback_receiver_name', v_fname,
        'fallback_receiver_number', v_fnum
      ),
      'qr_config_version', v_new_version
    )
  );

  return jsonb_build_object(
    'qr_config_version', v_new_version,
    'qr_updated_at', now()
  );
end;
$$;

revoke all on function public.start_qr_change_otp(jsonb, text) from public;
grant execute on function public.start_qr_change_otp(jsonb, text) to authenticated;

revoke all on function public.verify_qr_change_otp(text) from public;
grant execute on function public.verify_qr_change_otp(text) to authenticated;
