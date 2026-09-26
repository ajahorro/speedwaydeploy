-- ============================================================================
-- 20261019000001_credit_ledger_authorized_write.sql
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Client symptom (customer booking submit, console):
--
--     POST /rest/v1/customer_credit_ledger 403 (Forbidden)
--     42501: new row violates row-level security policy
--            for table "customer_credit_ledger"
--
-- creditLedgerService.recordExcessCredit() inserted DIRECTLY into
-- customer_credit_ledger from the browser. That can never succeed: the only
-- write policy on the table is `credit_ledger_admin_write`, which requires
-- public.is_admin(). The customer paying an overpayment is, by definition, not
-- an admin. So every legitimate overpayment was rejected — and because the
-- caller passes `sendFailure: false` it did not even surface as a booking
-- failure, it just silently lost the credit.
--
-- A second, quieter defect sat behind it: the browser computed
-- `balance_after = fetchExcessCredit(...) + amount` and wrote it. But
-- customer_excess_credit() is `sum(amount)` over ALL entries, including the
-- negative 'ABSORBED' / 'REFUND_QUEUED' rows. Two concurrent bookings both read
-- the same balance, and both wrote a balance_after derived from it — a classic
-- lost-update that corrupts the running balance the UI displays.
--
-- THE FIX (long-term shape)
-- -------------------------
--   * Write through a SECURITY DEFINER function, mirroring how every other
--     money path in this system already works (apply_service_downpayment,
--     settle_overpayment_on_completion). The table stays append-only and
--     RLS-locked to admins for direct access; the browser stops touching it.
--   * Compute `balance_after` INSIDE the transaction under a per-customer
--     advisory lock, so concurrent bookings serialize instead of clobbering.
--   * Make it IDEMPOTENT per (booking, entry_type): a retried submit cannot
--     credit the same surplus twice. This is the real defence against the
--     "excess credit recorded twice" class of bug.
--   * Validate the caller: a customer may only record credit for THEMSELVES;
--     admins may record for anyone. Anonymous callers are rejected outright.
-- ============================================================================

create or replace function public.record_excess_credit(
  p_customer_id uuid,
  p_booking_id  uuid,
  p_amount      numeric,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount   numeric := coalesce(p_amount, 0);
  v_existing numeric;
  v_balance  numeric;
  v_booking_customer uuid;
  v_is_admin boolean := public.is_admin();
  v_caller   uuid := auth.uid();
begin
  -- ---- Authorization ------------------------------------------------------
  -- A customer may only record credit on their own ledger. Admins may act on
  -- any customer (desk/override). Everything else is refused. This replaces a
  -- table policy that simply rejected ALL writes, including legitimate ones.
  if v_caller is null then
    raise exception 'record_excess_credit: authentication required'
      using errcode = 'insufficient_privilege';
  end if;

  if not v_is_admin and v_caller <> p_customer_id then
    raise exception 'record_excess_credit: a customer may only record credit on their own ledger'
      using errcode = 'insufficient_privilege';
  end if;

  if p_customer_id is null then
    raise exception 'record_excess_credit: customer id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A non-positive surplus is a no-op, not an error: callers legitimately call
  -- this on every booking and only some have an overpayment.
  if v_amount <= 0 then
    return jsonb_build_object('recorded', 0, 'balance_after', public.customer_excess_credit(p_customer_id));
  end if;

  -- ---- Booking must belong to the customer --------------------------------
  if p_booking_id is not null then
    select customer_id into v_booking_customer
      from public.bookings where id = p_booking_id;

    if v_booking_customer is null then
      raise exception 'record_excess_credit: booking % not found', p_booking_id
        using errcode = 'no_data_found';
    end if;

    if v_booking_customer <> p_customer_id then
      raise exception 'record_excess_credit: booking does not belong to the given customer'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Serialize per customer: the balance read and the insert must be one atomic
  -- step, or two concurrent bookings lose an update (the defect described above).
  perform pg_advisory_xact_lock(hashtext('speedway:credit:' || p_customer_id::text));

  -- ---- Idempotency --------------------------------------------------------
  -- One EXCESS entry per booking. Without this, any client retry (a dropped
  -- response, a double-tapped submit) credits the same surplus again.
  if p_booking_id is not null then
    select amount into v_existing
      from public.customer_credit_ledger
     where customer_id = p_customer_id
       and booking_id = p_booking_id
       and entry_type = 'EXCESS'
     limit 1;

    if v_existing is not null then
      return jsonb_build_object(
        'recorded', 0,
        'already_recorded', v_existing,
        'balance_after', public.customer_excess_credit(p_customer_id)
      );
    end if;
  end if;

  -- ---- Write --------------------------------------------------------------
  v_balance := public.customer_excess_credit(p_customer_id) + v_amount;

  insert into public.customer_credit_ledger
    (customer_id, booking_id, entry_type, amount, balance_after, note)
  values
    (p_customer_id, p_booking_id, 'EXCESS', v_amount, v_balance,
     coalesce(nullif(btrim(p_note), ''), 'Overpayment surplus recorded as excess credit'));

  return jsonb_build_object('recorded', v_amount, 'balance_after', v_balance);
end;
$$;

comment on function public.record_excess_credit(uuid, uuid, numeric, text) is
  'Authorized, serialized, idempotent excess-credit write. Replaces the direct client INSERT that RLS rejected with 42501. One EXCESS row per booking; balance_after computed under a per-customer advisory lock so concurrent bookings cannot lose an update.';

revoke all on function public.record_excess_credit(uuid, uuid, numeric, text) from public;
grant execute on function public.record_excess_credit(uuid, uuid, numeric, text) to authenticated;