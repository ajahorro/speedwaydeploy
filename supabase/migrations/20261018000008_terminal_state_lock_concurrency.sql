-- ============================================================================
-- Batch 1 Additions — Scenarios 15, 19 & 20: Terminal-state lock + concurrency
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The backend routes `/api/bookings/add-service` and
-- `/api/bookings/update-master-status` performed a CHECK-THEN-ACT sequence with
-- NO row lock:
--
--     select status, total_amount from bookings where id = $1      -- check
--     insert into booking_vehicle_services (...)                   -- act
--     update bookings set total_amount = total + $price            -- act
--
-- Two problems follow:
--
--   SC-19  POST-COMPLETION SERVICE INJECTION. A booking already marked
--          'released'/'completed' should reject any mutation. The route checked
--          the status text, but the check and the write were separate statements
--          with no lock — a request that read the status a moment before
--          completion could still inject a $500 service into a CLOSED ledger.
--
--   SC-20  CANCELLATION vs UPSELL RACE. A customer cancels while an admin
--          applies a discount / adds a service. Both read the pre-race status,
--          both pass, and the loser leaves ORPHANED data (e.g. total_amount
--          reduced on a cancelled booking, or a 'PAID' upsell payment on a
--          booking that is now cancelled and queued for refund).
--
-- THE FIX
-- -------
-- One atomic RPC, `mutate_booking_locked()`, that:
--   * takes a row lock (SELECT … FOR UPDATE) on the booking FIRST,
--   * re-reads the status UNDER the lock (so the guard cannot be raced),
--   * enforces a TERMINAL-STATE allowlist (released/completed/cancelled are
--     immutable), and
--   * applies the total delta and the optional child rows in the SAME
--     transaction, so a partial mutation is impossible.
--
-- A companion `booking_is_mutable()` predicate lets any route pre-check the same
-- rule cheaply, and a `booking_assert_mutable()` trigger hard-blocks direct
-- writes to a terminal booking (defence in depth, mirrors the RPC guard).
-- ============================================================================

-- ── 1. Terminal-state predicate ─────────────────────────────────────────────
create or replace function public.booking_is_terminal(p_status text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(p_status, '')) in ('released', 'completed', 'cancelled', 'flagged_noshow');
$$;

comment on function public.booking_is_terminal(text) is
  'Scenarios 19/20: TRUE for a booking status whose financial ledger is CLOSED and must never be mutated.';


-- ── 2. Atomic, locked mutation RPC ──────────────────────────────────────────
create or replace function public.mutate_booking_locked(
  p_booking_id uuid,
  p_total_delta numeric default 0,
  p_end_delta_minutes integer default 0,
  p_service jsonb default null,
  p_payment jsonb default null,
  p_actor_id uuid default null,
  p_actor_name text default null,
  p_actor_role text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking        public.bookings%rowtype;
  v_now            timestamptz := now();
  v_new_total      numeric;
  v_new_end        timestamptz;
  v_vehicle_ok     boolean;
begin
  -- Lock the booking row FOR UPDATE. Every concurrent mutator (cancel, upsell,
  -- add-service, reschedule) now serializes on this row, so a check-then-act can
  -- never interleave.
  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;

  if not found then
    raise exception 'Booking not found' using errcode = 'no_data_found';
  end if;

  -- SC-19 / SC-20: TERMINAL STATE IS IMMUTABLE. Re-checked UNDER the lock, so a
  -- concurrent cancellation that committed first now correctly wins and the
  -- losing upsell/service-add is rejected — the loser fails SAFELY with a clean,
  -- classifiable error rather than corrupting a closed ledger.
  if public.booking_is_terminal(v_booking.status) then
    raise exception 'This booking is closed (status: %) and can no longer be modified.', v_booking.status
      using errcode = 'check_violation';
  end if;

  v_new_total := coalesce(v_booking.total_amount, 0) + coalesce(p_total_delta, 0);
  v_new_end := case
    when p_end_delta_minutes is null or p_end_delta_minutes = 0 then v_booking.end_datetime
    else coalesce(v_booking.end_datetime, v_booking.start_datetime, v_now)
         + make_interval(mins => p_end_delta_minutes)
  end;

  -- Optional service line, validated to belong to THIS booking.
  if p_service is not null and jsonb_typeof(p_service) = 'object' then
    select exists (
      select 1 from public.booking_vehicles bv
       where bv.id = nullif(p_service ->> 'booking_vehicle_id', '')::uuid
         and bv.booking_id = p_booking_id
    ) into v_vehicle_ok;

    if not v_vehicle_ok then
      raise exception 'Vehicle does not belong to this booking' using errcode = 'check_violation';
    end if;

    insert into public.booking_vehicle_services (
      booking_vehicle_id, service_name, price, duration_minutes, vehicle_type, service_snapshot
    ) values (
      nullif(p_service ->> 'booking_vehicle_id', '')::uuid,
      p_service ->> 'service_name',
      coalesce((p_service ->> 'price')::numeric, 0),
      nullif(p_service ->> 'duration_minutes', '')::integer,
      p_service ->> 'vehicle_type',
      p_service -> 'service_snapshot'
    );
  end if;

  -- Optional payment line.
  if p_payment is not null and jsonb_typeof(p_payment) = 'object' then
    insert into public.payments (
      booking_id, amount, method, payment_type, status, reference_number,
      verified_by, verified_at, notes
    ) values (
      p_booking_id,
      coalesce((p_payment ->> 'amount')::numeric, 0),
      p_payment ->> 'method',
      p_payment ->> 'payment_type',
      coalesce(p_payment ->> 'status', 'PAID'),
      nullif(p_payment ->> 'reference_number', ''),
      coalesce(nullif(p_payment ->> 'verified_by', '')::uuid, p_actor_id),
      coalesce(nullif(p_payment ->> 'verified_at', '')::timestamptz, v_now),
      p_payment ->> 'notes'
    );
  end if;

  update public.bookings
     set total_amount = v_new_total,
         end_datetime = v_new_end,
         updated_at = v_now
   where id = p_booking_id;

  insert into public.audit_logs (
    booking_id, action_type, details, actor_name, actor_role, actor_id, metadata
  ) values (
    p_booking_id,
    'BOOKING_MUTATED',
    coalesce(p_note, format('Booking mutated: total delta %s, end delta %s min.', p_total_delta, p_end_delta_minutes)),
    coalesce(p_actor_name, 'System'),
    coalesce(p_actor_role, 'SYSTEM'),
    p_actor_id,
    jsonb_build_object(
      'total_delta', p_total_delta,
      'old_total', v_booking.total_amount,
      'new_total', v_new_total,
      'end_delta_minutes', p_end_delta_minutes
    )
  );

  return jsonb_build_object(
    'booking_id', p_booking_id,
    'old_total', v_booking.total_amount,
    'new_total', v_new_total,
    'status', v_booking.status
  );
end;
$$;

comment on function public.mutate_booking_locked(uuid, numeric, integer, jsonb, jsonb, uuid, text, text, text) is
  'Scenarios 15/19/20: atomic, row-locked booking mutation. Refuses any change to a terminal (released/completed/cancelled) booking and serializes concurrent cancel/upsell/add-service so the loser fails safely.';

revoke all on function public.mutate_booking_locked(uuid, numeric, integer, jsonb, jsonb, uuid, text, text, text) from public;
grant execute on function public.mutate_booking_locked(uuid, numeric, integer, jsonb, jsonb, uuid, text, text, text) to service_role;


-- ── 3. Defence-in-depth trigger for direct writes ───────────────────────────
-- Even a direct UPDATE that bypasses the RPC (a future route, a manual SQL fix)
-- cannot re-price a terminal booking.
create or replace function public.block_terminal_booking_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.booking_is_terminal(old.status)
     and (new.total_amount is distinct from old.total_amount
          or new.end_datetime is distinct from old.end_datetime
          or new.start_datetime is distinct from old.start_datetime) then
    raise exception 'Booking % is in a terminal state (%) and its financial/time fields are immutable.',
      old.id, old.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_block_terminal_booking_mutation on public.bookings;
create trigger trg_block_terminal_booking_mutation
  before update on public.bookings
  for each row
  execute function public.block_terminal_booking_mutation();

comment on function public.block_terminal_booking_mutation() is
  'Scenarios 19/20: blocks any UPDATE that re-prices or re-times a terminal (released/completed/cancelled) booking, guarding closed financial ledgers against late mutations.';

-- Block inserting a service line onto a terminal booking.
create or replace function public.block_terminal_service_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select b.status into v_status
    from public.bookings b
    join public.booking_vehicles bv on bv.booking_id = b.id
   where bv.id = new.booking_vehicle_id
   limit 1;

  if public.booking_is_terminal(v_status) then
    raise exception 'Cannot add a service to a booking that is already % (closed ledger).', v_status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_block_terminal_service_insert on public.booking_vehicle_services;
create trigger trg_block_terminal_service_insert
  before insert on public.booking_vehicle_services
  for each row
  execute function public.block_terminal_service_insert();

comment on function public.block_terminal_service_insert() is
  'Scenario 19: refuses to INSERT a service line onto a terminal booking (the post-completion Ceramic Coating injection).';