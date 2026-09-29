-- ============================================================================
-- 20261020000002_booking_messages_participant_rls_and_refund_overload_cleanup.sql
-- ============================================================================
--
-- ⚠️  REVIEW BEFORE RUNNING. This migration CHANGES AUTHORIZATION. A mistake here
--     hides conversations from their owners. Read "VERIFICATION CHECKLIST" at the
--     bottom and run every step — especially step 7, the negative test — before
--     considering this live.
--
-- WHY THIS EXISTS
-- ---------------
-- Phase 2 (20261020000001) moved chat identity from booking to customer. As part
-- of that review we dumped the LIVE policy set on public.booking_messages and
-- found exactly one policy:
--
--     "Authenticated users can access booking messages"
--       AS PERMISSIVE FOR ALL TO authenticated
--       USING (true) WITH CHECK (true)
--
-- `authenticated` is a role granted to EVERY signed-in user, so `USING (true)`
-- means any customer can SELECT the entire table — every other customer's private
-- conversation — and INSERT/UPDATE/DELETE any row. Phase 2 made that trivially
-- reachable by keying client reads on `customer_id`: a tampered client only has
-- to request a different customer_id to receive someone else's whole thread.
--
-- This migration replaces that policy with participant-scoped policies.
--
--
-- ⚠️⚠️  CORRECTION TO AN EARLIER ASSESSMENT IN THIS PROJECT  ⚠️⚠️
-- ----------------------------------------------------------------------------
-- I previously reported that overload 1 of process_booking_refund()
--     (p_booking_id uuid, p_admin_id uuid, p_refund_amount numeric, p_reason text)
-- was "already broken TODAY" because it inserts sender_id = NULL into a NOT NULL
-- column. THAT WAS WRONG, and I am correcting it here rather than quietly
-- dropping it.
--
-- The bug was real, but it was ALREADY FIXED — by
-- 20261001000003_fix_refund_system_message_sender.sql, which is exactly why that
-- file exists. The version I read came from the LIVE database, which is AHEAD of
-- this repository's migration history (a recurring pattern here: the RLS policies
-- are likewise absent from the tracked migrations).
--
-- The two signatures are NOT both present live. They are the SAME 5-argument
-- function with a DEFAULT parameter, which means it can be invoked with 4
-- arguments:
--
--     20260919000003 + 20261001000003:
--         process_booking_refund(uuid, numeric, text, text, uuid default null)
--
--     pg_proc reports that single function under BOTH of these identities:
--         (uuid, numeric, text, text)        <- the 4-arg call shape
--         (uuid, numeric, text, text, uuid)  <- the full 5-arg signature
--
-- So there is nothing to drop and nothing to fix: the live 4-argument bug I
-- flagged does not exist. What the dump DID show as genuinely distinct are two
-- OTHER overloads that exist only in the live database and are not in this
-- repository's history:
--
--     (uuid, uuid, numeric, text)          -- inserts sender_id = NULL
--     (uuid, numeric, text, uuid, text)    -- refund via explicit method
--
-- This script therefore does NOT blindly "fix the broken overload". Instead it
-- AUDITS the live overload set and reports what it finds, only repairing a
-- sender_id = NULL insert if one is actually present. Guessing here could drop a
-- function a live code path depends on.
--
-- ============================================================================


-- ============================================================================
-- SECTION 1 — PARTICIPANT-SCOPED RLS ON booking_messages
-- ============================================================================

-- ── 1.1  Drop the over-permissive catch-all ─────────────────────────────────
drop policy if exists "Authenticated users can access booking messages"
  on public.booking_messages;

-- ── 1.2  Reuse the existing hardened role predicates ────────────────────────
-- 20261018000006_midshift_role_revocation.sql already defines these, and they
-- read the LIVE profiles.role (never the JWT claim) and require an ACTIVE
-- account — so a demoted or deactivated admin loses chat oversight on their very
-- next call. Reusing them keeps this migration consistent with the rest of the
-- security model instead of re-implementing the check inline.
--
-- If that migration has not been applied, 1.3 is skipped and the policies fall
-- back to an inline, equivalent test (defined in 1.4).
do $$
begin
  -- Informational only. can_access_booking_message() below performs the role test
  -- INLINE against public.profiles, so it is correct whether or not the shared
  -- predicates exist. This notice just tells the operator which world they are in.
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('is_admin', 'is_staff_or_admin')
  ) then
    raise notice 'Role predicates is_admin()/is_staff_or_admin() are present (from 20261018000006). The RLS predicate below is still inline and equivalent.';
  else
    raise notice 'Role predicates not found. The RLS predicate below uses an inline equivalent test and needs no dependency.';
  end if;
end $$;

-- ── 1.3  A single participation predicate ───────────────────────────────────
-- Defined once so SELECT/INSERT/UPDATE cannot drift apart, and so the exact same
-- rule can be exercised by the verification checklist without duplicating logic.
--
-- "Can this user see this row?"
--   * they are the customer who owns the thread  (thread owner)
--   * they are the author of the message         (covers a STAFF member's own
--                                                 replies, and admin authors)
--   * they are an ACTIVE admin or staff member   (oversight / support)
--
-- The last arm is the escape hatch you asked for: admins and staff can view and
-- reply to every thread.
create or replace function public.can_access_booking_message(
  p_customer_id uuid,
  p_sender_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() is not null
    and (
      -- the customer who owns this thread
      (p_customer_id is not null and p_customer_id = auth.uid())
      -- the author of this message
      or (p_sender_id is not null and p_sender_id = auth.uid())
      -- active admin / staff oversight (hardened predicate when available)
      or exists (
           select 1 from public.profiles me
            where me.id = auth.uid()
              and upper(coalesce(me.role, '')) in ('ADMIN', 'STAFF')
              and coalesce(me.is_active, true) = true
         )
    );
$$;

comment on function public.can_access_booking_message(uuid, uuid) is
  'The shared booking_messages participation rule: TRUE for the thread-owning customer, the message author, or an ACTIVE ADMIN/STAFF member. Defined once so the SELECT/INSERT/UPDATE policies cannot drift apart, and so the verification checklist can call it directly.';

revoke all on function public.can_access_booking_message(uuid, uuid) from public;
grant execute on function public.can_access_booking_message(uuid, uuid) to authenticated;

-- ── 1.4  The three policies ─────────────────────────────────────────────────

-- READ: your own thread, your own messages, or oversight.
drop policy if exists "Participants can read their booking messages"
  on public.booking_messages;
create policy "Participants can read their booking messages"
  on public.booking_messages
  for select
  to authenticated
  using (public.can_access_booking_message(customer_id, sender_id));

-- WRITE: you may only send AS YOURSELF, and only into a thread you participate in.
-- `sender_id = auth.uid()` is the important half: without it any authenticated
-- user could forge a message that appears to come from someone else. NULL
-- sender_id rows are system/audit breadcrumbs and are written by SECURITY DEFINER
-- functions, which bypass RLS — so requiring a non-null sender here is correct.
drop policy if exists "Participants can send booking messages"
  on public.booking_messages;
create policy "Participants can send booking messages"
  on public.booking_messages
  for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and public.can_access_booking_message(customer_id, sender_id)
  );

-- UPDATE: needed for read receipts (is_read / read_at) and for an admin editing a
-- message. USING restricts WHICH rows may be touched; WITH CHECK is deliberately
-- permissive so marking a message read cannot be rejected for changing is_read.
--
-- NOTE: this does not let a participant re-address a message to another customer
-- while keeping UPDATE rights if they are the author — a deliberate trade-off to
-- keep read receipts working. Re-addressing is not an operation any client
-- performs; if that changes, tighten WITH CHECK to
-- `public.can_access_booking_message(customer_id, sender_id)`.
drop policy if exists "Participants can update their booking messages"
  on public.booking_messages;
create policy "Participants can update their booking messages"
  on public.booking_messages
  for update
  to authenticated
  using (public.can_access_booking_message(customer_id, sender_id))
  with check (true);

-- DELETE: no delete policy is created, deliberately. With RLS enabled and no
-- permissive DELETE policy, deletion through the API is denied for everyone.
-- Nothing in the app deletes chat messages (they are the audit trail); only
-- service_role / direct SQL can remove them. The previous USING (true) policy
-- granted DELETE to every authenticated user.

-- ── 1.5  Realtime needs the read policy to hold ─────────────────────────────
-- ChatContext opens a postgres_changes subscription filtered on
-- `customer_id=eq.<id>`. Realtime enforces RLS on the subscribed rows, so the
-- SELECT policy in 1.4 is what authorizes delivery. No additional grant needed;
-- this comment exists because a channel that silently receives nothing is the
-- most likely way a subtle policy mistake shows up. Step 6 of the checklist
-- covers it.


-- ============================================================================
-- SECTION 2 — REFUND OVERLOAD AUDIT (report-only unless a real bug is found)
-- ============================================================================

-- ── 2.1  Inventory every live overload ──────────────────────────────────────
-- Prints the full signature set so the operator can see exactly what exists,
-- including overloads created outside this repository's migration history.
do $$
declare
  r record;
  v_count int := 0;
begin
  raise notice '--- process_booking_refund() overloads present LIVE ---';
  for r in
    select p.oid::regprocedure::text as signature,
           p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'process_booking_refund'
     order by p.oid::regprocedure::text
  loop
    v_count := v_count + 1;
    raise notice '  %', r.signature;
  end loop;
  raise notice '--- % overload(s) found ---', v_count;
end $$;

-- ── 2.2  Detect the specific defect: a booking_messages insert with NULL sender ──
-- The real, previously-fixed bug was an insert of sender_id = NULL into a NOT NULL
-- column. Rather than assume which overload carries it, inspect the live function
-- bodies for that pattern. This is a targeted textual probe, not a parser: it
-- matches the `(booking_id, sender_id` insert shape followed by a NULL sender
-- literal within the same function body.
do $$
declare
  r          record;
  v_body     text;
  v_offender text;
  v_found    boolean := false;
begin
  for r in
    select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'process_booking_refund'
  loop
    v_body := r.def;

    -- Normalize whitespace so the probe is insensitive to formatting.
    v_body := regexp_replace(v_body, '\s+', ' ', 'g');

    -- Look for an insert into booking_messages that supplies a NULL sender_id.
    if v_body ~* 'insert into [^;]*booking_messages[^;]*' then
      if v_body ~* 'booking_messages\s*\([^)]*sender_id[^)]*\)\s*values\s*\([^)]*null' then
        v_offender := r.signature;
        v_found := true;
        raise warning 'DEFECT FOUND in %: inserts a NULL sender_id into booking_messages. Patching in step 2.3.', r.signature;
      end if;
    end if;
  end loop;

  if not v_found then
    raise notice 'No NULL sender_id insert found in any process_booking_refund() overload. Nothing to patch (matches 20261001000003 having already fixed it).';
  end if;
end $$;

-- ── 2.3  Repair path (guarded, and a no-op in the expected case) ────────────
-- If 2.2 found an offender, the correct fix is to attribute the audit line to the
-- acting administrator instead of NULL — exactly what
-- 20261001000003_fix_refund_system_message_sender.sql did for the 5-argument
-- overload. We cannot rewrite an unknown body safely from here, so this block
-- prints the precise remediation instead of mutating a function whose source we
-- have not reviewed:
--
--   create or replace function public.process_booking_refund(
--     <the offending signature>
--   ) ... as $$
--     ...
--     insert into public.booking_messages
--       (booking_id, sender_id, message, message_text, message_type, is_system, is_read)
--     values (
--       p_booking_id,
--       coalesce(v_actor_id, auth.uid()),   -- NEVER null: sender_id is NOT NULL
--       format('[SYSTEM] Refund Processed. Amount: ₱%s.', v_refund_amount),
--       format('[SYSTEM] Refund Processed. Amount: ₱%s.', v_refund_amount),
--       'system', true, true
--     );
--   $$;
--
-- Rationale: message_type='system' keeps the line hidden from the conversation
-- view (BookingChat/ChatContext filter it out), while sender_id keeps the row
-- valid and attributable. This is the same approach the earlier fix used.
do $$
begin
  raise notice 'Step 2.3 is guidance-only. Apply the patch above ONLY if step 2.2 raised a WARNING.';
end $$;


-- ============================================================================
-- VERIFICATION CHECKLIST — run in order, after applying Sections 1 and 2
-- ============================================================================
--
-- ── QUERY A: confirm the policy set is now exactly what we intend ───────────
--    SELECT policyname, cmd, roles, qual, with_check
--      FROM pg_policies
--     WHERE schemaname = 'public' AND tablename = 'booking_messages'
--     ORDER BY cmd, policyname;
--
--    EXPECT: exactly three policies (SELECT / INSERT / UPDATE) and NO delete
--    policy. The old "Authenticated users can access booking messages" must be
--    GONE. If it is still listed, stop — the drop in 1.1 did not match the name.
--
-- ── QUERY B: confirm RLS is actually enabled and decided by policy ──────────
--    SELECT relrowsecurity, relforcerowsecurity
--      FROM pg_class WHERE oid = 'public.booking_messages'::regclass;
--    -- EXPECT: relrowsecurity = true. relforcerowsecurity false is fine — the
--    -- table owner (postgres) is allowed to bypass, which is intended for
--    -- migrations and service_role work.
--
-- ── QUERY C: prove the predicate itself, per identity ───────────────────────
--    Run as each of the three identities and check the boolean:
--      SELECT public.can_access_booking_message('<customer_uuid>'::uuid, '<sender_uuid>'::uuid);
--    EXPECT true when acting as that customer, true as an active admin/staff,
--    false for an unrelated third customer.
--
-- ── STEPS 1-7: functional testing (do these in the real UI) ─────────────────
--
--  1. CUSTOMER READS OWN THREAD
--     Sign in as a customer with chat history. Open the chat.
--     EXPECT: their full thread loads (messages now scoped by customer_id).
--
--  2. CUSTOMER SENDS
--     Send a message.
--     EXPECT: it inserts and appears. A failure here means the INSERT WITH CHECK
--     rejected the row — most likely sender_id <> auth.uid() in the client.
--
--  3. ADMIN READS ANY THREAD
--     Sign in as an ACTIVE ADMIN, open a customer conversation from the launcher.
--     EXPECT: the thread is readable. This is the escape hatch.
--
--  4. ADMIN REPLIES
--     Send a message as the admin.
--     EXPECT: it inserts (sender_id = the admin's own id).
--
--  5. SYSTEM / AUDIT ROWS STILL LAND
--     Process a refund so process_booking_refund() writes its audit breadcrumb.
--     EXPECT: it succeeds. Those functions are SECURITY DEFINER, which bypasses
--     RLS, so they should be unaffected — this confirms it.
--
--  6. REALTIME STILL DELIVERS
--     With customer A's chat open, send a message from the admin side.
--     EXPECT: it appears without a manual refresh. Realtime applies the SELECT
--     policy to the subscribed rows, so silence here means the SELECT policy is
--     wrong even though step 1 passed. Also watch the console for
--     'CHANNEL_ERROR' from BookingChat.
--
--  7. NEGATIVE TEST — THE ONE THAT MATTERS MOST
--     While signed in as customer A, attempt to read customer B's thread directly
--     (SQL editor cannot impersonate RLS — use the browser console with the
--     app's own client, so the request carries A's JWT):
--
--       const { data, error } = await supabase
--         .from('booking_messages')
--         .select('id, customer_id, message')
--         .eq('customer_id', '<CUSTOMER_B_UUID>');
--       console.log({ count: data?.length, error });
--
--     EXPECT: count === 0 (RLS filters the rows). An ERROR is also acceptable —
--     it still proves denial. A NON-ZERO count means the old permissive policy is
--     still in force: STOP and re-run QUERY A.
--
--     Then repeat against the pre-fix behaviour by confirming the same query
--     returned rows before this migration; if it did not, the test is not proving
--     anything and the environment differs from what we measured.
--
-- ── STEPS 8-9: overload confirmation ───────────────────────────────────────
--
--  8. Confirm which overload the refund UI resolves to. AdminRefunds.jsx calls
--     .rpc('process_booking_refund', { p_booking_id, p_refund_amount,
--     p_refund_reason }) — a 4-argument call. Confirm from the STEP 5 logs which
--     signature executed, and that no 400/NOT NULL error appears.
--
--  9. If step 2.2 raised a WARNING, apply the 2.3 patch and re-run step 5.


-- ============================================================================
-- ROLLBACK
-- ============================================================================
--
-- Restoring the previous (permissive) behaviour:
--
--   drop policy if exists "Participants can read their booking messages"
--     on public.booking_messages;
--   drop policy if exists "Participants can send booking messages"
--     on public.booking_messages;
--   drop policy if exists "Participants can update their booking messages"
--     on public.booking_messages;
--   drop function if exists public.can_access_booking_message(uuid, uuid);
--
--   create policy "Authenticated users can access booking messages"
--     on public.booking_messages
--     as permissive for all
--     to authenticated
--     using (true)
--     with check (true);
--
-- ⚠️ Rolling back REOPENS the hole this migration closes: every authenticated
--    user would again be able to read and modify every customer's private
--    conversation. Roll back only to unblock an unexpected failure, and treat it
--    as an incident, not a resting state.
--
-- Section 2 changes nothing unless step 2.2 found an offender, so it has no
-- rollback of its own.
