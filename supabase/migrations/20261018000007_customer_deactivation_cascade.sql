-- ============================================================================
-- Batch 1 Additions — Scenario 14: The "Ghosted" Customer Deactivation
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- A VIP customer with 5 past completed bookings, active chats, and 1 upcoming
-- booking is deactivated by an admin. The audit asks three things:
--
--   1. Does the UPCOMING booking auto-cancel and free the slot?
--      — Previously NO. Deactivation only flipped is_active; the upcoming
--        booking kept its slot locked, and the customer (now gone) never showed
--        up. The slot was wasted.
--
--   2. Do the 5 PAST bookings lose their customer_id (corrupting financial
--      metrics)? — Already SAFE: deactivation is a soft-delete (is_active =
--      false), so bookings.customer_id, payments, and the ledger are untouched.
--      This migration merely guarantees that stays true.
--
--   3. What if the deactivated user tries to register again?
--      — With password auth the login flow already offers a 15-day recovery.
--        The DANGER is CLIENT-SIDE recovery: `recoverAccount()` wrote directly
--        to profiles, so a user could self-reactivate from the browser at ANY
--        time (even past the grace window) and RLS permitted it. We make
--        recovery a SERVER-AUTHORITATIVE, window-checked RPC.
--
-- DESIGN
--   * `deactivate_customer_account()` — soft-delete, cancel the upcoming
--     bookings in ONE transaction, release their bays, and audit it.
--   * `recover_account()` — reactivates ONLY within the grace window and only
--     for the caller's own account; expired accounts cannot self-recover.
-- ============================================================================

-- ── 0. Grace window config ──────────────────────────────────────────────────
alter table public.business_config
  add column if not exists account_recovery_grace_days integer not null default 15;

comment on column public.business_config.account_recovery_grace_days is
  'Scenario 14: how many days a deactivated account may self-recover before it is treated as permanently purged.';


-- ── 1. Deactivation with cascade (upcoming bookings) ────────────────────────
create or replace function public.deactivate_customer_account(
  p_user_id uuid,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile       public.profiles%rowtype;
  v_grace_days    integer := 15;
  v_cancelled_ids uuid[] := '{}';
  v_actor         uuid := coalesce(p_actor_id, auth.uid());
  v_booking       record;
begin
  -- A user may deactivate themselves; an admin may deactivate anyone.
  if not (auth.uid() = p_user_id or public.is_admin()) then
    raise exception 'You are not authorized to deactivate this account';
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Account not found';
  end if;

  select coalesce(account_recovery_grace_days, 15) into v_grace_days
    from public.business_config order by id limit 1;

  -- Soft-delete ONLY. Never touch historical rows: past bookings, payments and
  -- audit entries keep their customer_id / actor_id, so financial metrics remain
  -- intact (the explicit requirement of this scenario).
  update public.profiles
     set is_active = false,
         deactivated_at = now(),
         updated_at = now()
   where id = p_user_id;

  -- Cascade: cancel every UPCOMING (future, non-terminal) booking so the slot is
  -- freed for another customer. Terminal and PAST bookings are never modified.
  for v_booking in
    select id from public.bookings
     where customer_id = p_user_id
       and start_datetime > now()
       and lower(coalesce(status, '')) not in ('cancelled', 'completed', 'released', 'flagged_noshow')
     for update
  loop
    v_cancelled_ids := v_cancelled_ids || v_booking.id;

    update public.bookings
       set status = 'cancelled',
           staff_id = null,
           bay_id = null,
           cancellation_reason = 'Account deactivated by owner',
           cancellation_type = 'ACCOUNT_DEACTIVATED',
           refund_status = case
             when exists (select 1 from public.payments p
                           where p.booking_id = v_booking.id
                             and p.amount > 0
                             and upper(coalesce(p.status,'')) in ('PAID','REFUND_PENDING'))
             then 'QUEUED' else refund_status end,
           updated_at = now()
     where id = v_booking.id;

    -- Free the bays of the cancelled booking.
    update public.booking_vehicles
       set status = 'cancelled'
     where booking_id = v_booking.id;
  end loop;

  insert into public.audit_logs (
    action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    'ACCOUNT_DEACTIVATION',
    format('Account %s deactivated. %s upcoming booking(s) cancelled to free their slots. Recoverable for %s days.',
           coalesce(v_profile.email, p_user_id::text),
           coalesce(array_length(v_cancelled_ids, 1), 0),
           v_grace_days),
    coalesce((select full_name from public.profiles where id = v_actor), 'System'),
    case when public.is_admin() then 'ADMIN' else 'USER' end,
    v_actor,
    jsonb_build_object(
      'user_id', p_user_id,
      'cancelled_booking_ids', to_jsonb(v_cancelled_ids),
      'grace_days', v_grace_days
    )
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'is_active', false,
    'grace_days', v_grace_days,
    'cancelled_bookings', to_jsonb(v_cancelled_ids)
  );
end;
$$;

comment on function public.deactivate_customer_account(uuid, uuid) is
  'Scenario 14: soft-deletes a customer (is_active=false, history preserved), cancels their UPCOMING bookings to free slots, and audits the action. Past bookings/payments are never modified.';

revoke all on function public.deactivate_customer_account(uuid, uuid) from public;
grant execute on function public.deactivate_customer_account(uuid, uuid) to authenticated;


-- ── 2. Server-authoritative recovery (grace-window enforced) ────────────────
create or replace function public.recover_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile    public.profiles%rowtype;
  v_grace_days integer := 15;
  v_deadline   timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile from public.profiles where id = auth.uid() for update;
  if not found then
    raise exception 'Account not found';
  end if;

  if coalesce(v_profile.is_active, true) then
    return jsonb_build_object('recovered', false, 'reason', 'ALREADY_ACTIVE');
  end if;

  select coalesce(account_recovery_grace_days, 15) into v_grace_days
    from public.business_config order by id limit 1;

  v_deadline := coalesce(v_profile.deactivated_at, now() - interval '100 years')
                + make_interval(days => v_grace_days);

  if now() > v_deadline then
    -- Past the grace window: refuse. The account is treated as purged.
    raise exception 'The recovery window for this account has expired (after % days).', v_grace_days
      using errcode = 'check_violation';
  end if;

  update public.profiles
     set is_active = true,
         deactivated_at = null,
         updated_at = now()
   where id = auth.uid();

  insert into public.audit_logs (
    action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    'ACCOUNT_RECOVERED',
    format('Account %s recovered within the %s-day grace window.', coalesce(v_profile.email, 'unknown'), v_grace_days),
    coalesce(v_profile.full_name, v_profile.email, 'User'), 'USER', auth.uid(),
    jsonb_build_object('user_id', auth.uid(), 'deactivated_at', v_profile.deactivated_at, 'recovered_at', now())
  );

  return jsonb_build_object(
    'recovered', true,
    'user_id', auth.uid(),
    'grace_days', v_grace_days,
    'recovered_at', now()
  );
end;
$$;

comment on function public.recover_account() is
  'Scenario 14: server-authoritative account recovery. Only the caller may recover their own account, and only within the configured grace window; an expired account cannot self-reactivate.';

revoke all on function public.recover_account() from public;
grant execute on function public.recover_account() to authenticated;