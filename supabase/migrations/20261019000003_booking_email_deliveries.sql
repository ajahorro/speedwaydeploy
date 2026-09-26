-- ============================================================================
-- 20261019000003_booking_email_deliveries.sql
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The customer was flooded with emails for a single booking. Two separate
-- mechanisms caused it and neither was guarded at the database:
--
--   1. A booking submission dispatched BOTH a "Payment Submitted" notification
--      email (client eventEngine) AND a "Booking is now SCHEDULED" lifecycle
--      email (send-status-email). Two mails, two different amounts.
--
--   2. Nothing recorded that an email had been sent. Any retry — a double-tapped
--      submit, a re-run of a status transition, an at-least-once webhook — sent
--      the mail again. Idempotency lived in client memory, which cannot survive
--      a reload and is not shared between the client, the backend and the edge
--      functions.
--
-- THE FIX
-- -------
-- A delivery ledger keyed on (booking_id, event). Claiming a delivery is an
-- INSERT that either succeeds (this is the first and only send) or hits the
-- primary key (someone already sent it). That makes "exactly one email per
-- booking per event" a DATABASE INVARIANT rather than a convention each caller
-- is trusted to honour.
--
-- `claim_booking_email()` is SECURITY DEFINER so the edge function and the
-- backend share one implementation and one truth.
--
-- Deliberately NOT keyed on status alone: a booking legitimately returns to the
-- same status after a reschedule, and that IS a new event worth telling the
-- customer about. Callers pass a distinct event key for those cases
-- (e.g. 'booking_confirmed:2026-10-20T09:00'), so the guard blocks genuine
-- duplicates without silencing legitimate re-notifications.
-- ============================================================================

create table if not exists public.booking_email_deliveries (
  booking_id   uuid not null references public.bookings(id) on delete cascade,
  event        text not null,
  channel      text not null default 'email',
  recipient    text,
  resend_id    text,
  sent_at      timestamptz not null default now(),
  sent_by      text,
  primary key (booking_id, event)
);

comment on table public.booking_email_deliveries is
  'Exactly-once guard for customer emails. One row per (booking, event). A second attempt to claim the same event is refused, so retries and double-submits cannot send duplicate mail.';

create index if not exists booking_email_deliveries_booking_idx
  on public.booking_email_deliveries (booking_id, sent_at desc);

alter table public.booking_email_deliveries enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='booking_email_deliveries' and policyname='booking_email_deliveries_admin_read') then
    create policy booking_email_deliveries_admin_read on public.booking_email_deliveries
      for select to authenticated using (public.is_admin());
  end if;
end $$;

-- ── Claim an email slot ─────────────────────────────────────────────────────
-- Returns { claimed: true } exactly once per (booking, event). Every other call
-- returns { claimed: false } with the original send time, so the caller skips
-- the send instead of duplicating it.
create or replace function public.claim_booking_email(
  p_booking_id uuid,
  p_event      text,
  p_recipient  text default null,
  p_sent_by    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.booking_email_deliveries%rowtype;
begin
  if p_booking_id is null or p_event is null or btrim(p_event) = '' then
    raise exception 'claim_booking_email: booking id and event are required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Fast path: already sent.
  select * into v_existing
    from public.booking_email_deliveries
   where booking_id = p_booking_id and event = p_event;

  if found then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'ALREADY_SENT',
      'sent_at', v_existing.sent_at,
      'recipient', v_existing.recipient
    );
  end if;

  -- Insert-or-lose. ON CONFLICT DO NOTHING makes the race safe: two concurrent
  -- callers both try, exactly one wins, the loser sees 0 rows.
  insert into public.booking_email_deliveries (booking_id, event, recipient, sent_by)
  values (p_booking_id, p_event, p_recipient, p_sent_by)
  on conflict (booking_id, event) do nothing;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'RACE_LOST');
  end if;

  return jsonb_build_object('claimed', true);
end;
$$;

comment on function public.claim_booking_email(uuid, text, text, text) is
  'Exactly-once email claim. Returns claimed=true for the first caller of a (booking, event) pair and claimed=false for every later one, making duplicate sends impossible rather than merely discouraged.';

-- ── Record the provider id (best-effort, for reconciliation) ────────────────
create or replace function public.record_booking_email_result(
  p_booking_id uuid,
  p_event      text,
  p_resend_id  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.booking_email_deliveries
     set resend_id = coalesce(p_resend_id, resend_id)
   where booking_id = p_booking_id and event = p_event;
end;
$$;

comment on function public.record_booking_email_result(uuid, text, text) is
  'Stores the provider message id after a successful send so a delivered mail can be traced back to its Resend record.';

-- ── Release a claim when the send FAILED ────────────────────────────────────
-- The claim is taken BEFORE the send (that is what makes it exactly-once). If
-- the provider then rejects the message, the claim must be released, or the
-- customer would never receive the mail at all — the opposite failure, and a
-- much worse one.
create or replace function public.release_booking_email_claim(
  p_booking_id uuid,
  p_event      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.booking_email_deliveries
   where booking_id = p_booking_id
     and event = p_event
     and resend_id is null;  -- never release a delivery that already succeeded
end;
$$;

comment on function public.release_booking_email_claim(uuid, text) is
  'Rolls back an email claim after a FAILED send so the mail can be retried. Refuses to release a claim that already has a provider id, so a delivered email can never be re-sent.';

revoke all on function public.claim_booking_email(uuid, text, text, text) from public;
revoke all on function public.record_booking_email_result(uuid, text, text) from public;
revoke all on function public.release_booking_email_claim(uuid, text) from public;

grant execute on function public.claim_booking_email(uuid, text, text, text) to authenticated;
grant execute on function public.record_booking_email_result(uuid, text, text) to authenticated;
grant execute on function public.release_booking_email_claim(uuid, text) to authenticated;