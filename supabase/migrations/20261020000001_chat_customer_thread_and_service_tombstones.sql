-- ============================================================================
-- 20261020000001_chat_customer_thread_and_service_tombstones.sql
-- ============================================================================
--
-- ⚠️  REVIEW BEFORE RUNNING. This script backfills EXISTING chat history and
--     RELAXES a NOT NULL constraint (booking_messages.booking_id). Every column
--     it ADDS is nullable, so no existing row can violate it. Nothing here is
--     destructive, but the backfill does write to production rows, so run the
--     verification SELECTs first. See "VERIFICATION", "ROLLBACK" and the
--     "SECURITY FOLLOW-UP" note at the bottom.
--
-- PURPOSE
-- -------
-- Two independent changes are combined here because they ship together:
--
--   SECTION A (Item 2) — ONE CUSTOMER = ONE CHAT.
--     Chat was keyed on `booking_id`, so a customer who booked five times had
--     five fragmented threads. This migrates the conversation identity to the
--     CUSTOMER by denormalizing `customer_id` onto `booking_messages`, then
--     backfilling every existing message from its booking so no history is lost.
--     `booking_id` is RETAINED and becomes a NULLABLE tag: a message may relate
--     to a specific booking, or to the customer generally (a general inquiry).
--
--     VERIFIED AGAINST THE LIVE DATABASE: the only RLS policy on
--     booking_messages is `USING (true) WITH CHECK (true)` for `authenticated`,
--     which references neither booking_id nor customer_id — so this section needs
--     NO policy patch. (That policy is independently over-permissive; see the
--     SECURITY FOLLOW-UP block at the end of this file.)
--
--   SECTION B (Item 3) — DURABLE SERVICE-DELETION TOMBSTONES.
--     `flattenDefaultServices()` regenerates the built-in catalog on every load,
--     so deleting an admin-visible built-in silently reverted ("success" but it
--     came back). The suppression is persisted by ID in a new
--     `business_config.archived_service_ids` column that survives regeneration.
--
-- ============================================================================


-- ============================================================================
-- SECTION A — 1 CUSTOMER = 1 CHAT
-- ============================================================================

-- ── A.1  Denormalize the thread owner onto every message ────────────────────
alter table public.booking_messages
  add column if not exists customer_id uuid;

comment on column public.booking_messages.customer_id is
  'Item 2 (1 customer = 1 chat): the CUSTOMER that owns this conversation thread. Denormalized from bookings.customer_id so the whole thread can be read and realtime-subscribed by customer without joining bookings. NULL only for messages that predate the migration and could not be mapped (e.g. the booking itself was deleted), or for accountless walk-in bookings that have no customer.';

-- Foreign key -> profiles.id. A customer deletion must NOT silently orphan the
-- audit trail of what was said, so ON DELETE SET NULL mirrors how bookings
-- reference their customer elsewhere in this schema.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'booking_messages_customer_id_fkey'
       and conrelid = 'public.booking_messages'::regclass
  ) then
    alter table public.booking_messages
      add constraint booking_messages_customer_id_fkey
      foreign key (customer_id) references public.profiles(id) on delete set null;
  end if;
end $$;

-- ── A.2  Backfill: map every existing message to its customer ───────────────
-- EVERY message currently carries a booking_id. We copy the customer across so
-- past chat history is retained and immediately appears in the correct
-- customer's single thread.
--
-- System rows (message_type = 'system', the refund/audit audit lines) are
-- backfilled too. They are filtered out of the visible conversation in the UI,
-- but keeping customer_id consistent means the realtime subscription is
-- complete and no row is left ambiguous.
--
-- Bookings whose customer_id is NULL (guest walk-ins) produce NULL here and are
-- deliberately excluded from every unread badge by the client.
update public.booking_messages m
   set customer_id = b.customer_id
  from public.bookings b
 where m.booking_id = b.id
   and m.customer_id is null
   and b.customer_id is not null;

-- ── A.3  Make booking_id a NULLABLE tag ────────────────────────────────────
-- A general inquiry belongs to the customer, not to any one booking.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'booking_messages'
       and column_name = 'booking_id'
       and is_nullable = 'NO'
  ) then
    alter table public.booking_messages alter column booking_id drop not null;
  end if;
end $$;

comment on column public.booking_messages.booking_id is
  'Item 2: OPTIONAL tag. The booking this message relates to, or NULL for a message with no booking context (a general inquiry in the customer''s continuous thread).';

-- ── A.4  Indexes for the new access pattern ────────────────────────────────
-- The thread read is `where customer_id = ? order by created_at`, and the unread
-- badge is `where customer_id = ? and is_read = false`.
create index if not exists idx_booking_messages_customer_created
  on public.booking_messages (customer_id, created_at);

create index if not exists idx_booking_messages_customer_unread
  on public.booking_messages (customer_id, is_read, sender_id);

-- The legacy index keyed on booking_id is retained: the booking-scoped view and
-- the tag feature still filter on it.
create index if not exists idx_booking_messages_booking_id
  on public.booking_messages (booking_id);

-- ── A.5  Attribute a new message to its customer automatically ─────────────
-- Any writer that still supplies only booking_id (an older client, a refactor
-- RPC, a manual SQL insert) must not create a message that falls outside the
-- customer's thread. This trigger fills customer_id from the booking.
create or replace function public.set_booking_message_customer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.customer_id is null and new.booking_id is not null then
    select b.customer_id into new.customer_id
      from public.bookings b
     where b.id = new.booking_id;
  end if;
  return new;
end;
$$;

comment on function public.set_booking_message_customer() is
  'Item 2: backfills booking_messages.customer_id from the tagged booking when a writer omits it, so every message lands in the correct customer thread.';

drop trigger if exists trg_set_booking_message_customer on public.booking_messages;
create trigger trg_set_booking_message_customer
  before insert or update of booking_id on public.booking_messages
  for each row execute function public.set_booking_message_customer();

-- ── A.6  Refund/audit system lines — VERIFIED, no change required ──────────
-- Four overloads of process_booking_refund() exist LIVE in public:
--
--   1. (p_booking_id uuid, p_admin_id uuid, p_refund_amount numeric, p_reason text)
--   2. (p_booking_id uuid, p_refund_amount numeric, p_refund_reason text, p_refund_ref text)
--   3. (p_booking_id uuid, p_refund_amount numeric, p_refund_reason text,
--       p_refund_reference text, p_actor_id uuid)          <-- the hardened one
--   4. (p_booking_id uuid, p_amount numeric, p_reason text, p_admin_id uuid, p_method text)
--
-- Two of them (1 and 3) insert into booking_messages with only booking_id; the
-- trigger created in A.5 fills their customer_id on the way in, so no overload
-- needs editing here.
--
-- ⚠️ UNRELATED PRE-EXISTING DEFECT — overload 1 is already broken TODAY,
--    independent of this migration. It runs:
--        INSERT INTO booking_messages (booking_id, sender_id, message)
--        VALUES (p_booking_id, NULL, 'System Notice: ...');
--    but sender_id is NOT NULL (FK -> profiles). That insert must raise 23502.
--    This script does NOT fix it and does NOT make it worse: the A.5 trigger is
--    BEFORE INSERT and only populates customer_id, so it cannot change whether
--    the NOT NULL on sender_id is satisfied. Fixing overload 1 (use the acting
--    admin as sender_id, as overload 3 already does) is a separate change.
--
--    ACTION FOR THE OPERATOR: confirm which overload the refund UI resolves to.
--    AdminRefunds.jsx calls .rpc('process_booking_refund', {p_booking_id,
--    p_refund_amount, p_refund_reason}) — a 4-argument call matching overload 2,
--    which does NOT write to booking_messages and is therefore unaffected. If a
--    live flow instead reaches overload 1, its refund would fail on the chat
--    insert; that is a pre-existing bug worth fixing before the alpha test, but
--    it is out of scope for this migration.
--
-- NOTE ON RLS — READ THIS BEFORE RUNNING ANYTHING.
-- The LIVE policy set on public.booking_messages was dumped and contains exactly
-- ONE policy:
--
--     "Authenticated users can access booking messages"
--       AS PERMISSIVE FOR ALL TO authenticated
--       USING (true) WITH CHECK (true)
--
-- IMPLICATIONS FOR THIS MIGRATION:
--   * SAFE. `booking_id` is not referenced by any policy expression, so making it
--     nullable breaks nothing. `WITH CHECK (true)` accepts the new customer_id
--     column we now write explicitly. NO policy change is required by Section A,
--     which is why there is no Section C in this script.
--
-- ⚠️ SEPARATE, PRE-EXISTING SECURITY HOLE (NOT INTRODUCED OR FIXED HERE):
--   `USING (true)` for role `authenticated` means ANY logged-in user can SELECT
--   every row in booking_messages — i.e. every other customer's messages. It also
--   lets any authenticated user INSERT/UPDATE/DELETE freely. Item 2 does not
--   create this hole, but it does make it reachable in a new way: the client now
--   reads and realtime-subscribes by `customer_id`, so a tampered client can ask
--   for another customer's id and receive their entire thread. The correct policy
--   scopes reads to the participant:
--
--       using (
--         customer_id = auth.uid()
--         or sender_id = auth.uid()
--         or exists (select 1 from public.profiles
--                     where id = auth.uid() and upper(role) in ('ADMIN','STAFF'))
--       )
--
--   This is DELIBERATELY NOT APPLIED HERE. Tightening it blindly could lock out
--   admin/staff threads, the realtime channel, or the null-customer_id system
--   rows, and that is not a change to make hours before an alpha test. It is
--   tracked as a follow-up: see the SECURITY FOLLOW-UP block at the end of this
--   file. Until then, treat the current policy as permissive by design.


-- ============================================================================
-- SECTION B — DURABLE SERVICE-DELETION TOMBSTONES (Item 3)
-- ============================================================================

-- `flattenDefaultServices()` in BusinessHub.jsx rebuilds the built-in service
-- catalog on every load and stamps each row `archived: false`. A deleted
-- built-in therefore only stayed hidden while a custom row carried a matching
-- id — any id drift resurrected it at its original price. The suppression is now
-- persisted by ID in this column and re-applied on every load.
alter table public.business_config
  add column if not exists archived_service_ids jsonb default '[]'::jsonb;

comment on column public.business_config.archived_service_ids is
  'Item 3: durable tombstones — the ids of services (built-in or custom) that the admin deleted or archived. Re-applied by flattenDefaultServices() on every load so a regenerated built-in cannot resurrect. An empty array means nothing is suppressed.';

-- Normalize any pre-existing NULL to an empty array so the client always reads
-- an array and never has to null-check.
update public.business_config
   set archived_service_ids = '[]'::jsonb
 where archived_service_ids is null;

-- Guard the shape: the client expects a JSON array and calls .map/.filter on it.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'business_config_archived_service_ids_is_array'
       and conrelid = 'public.business_config'::regclass
  ) then
    alter table public.business_config
      add constraint business_config_archived_service_ids_is_array
      check (archived_service_ids is null or jsonb_typeof(archived_service_ids) = 'array');
  end if;
end $$;


-- ============================================================================
-- VERIFICATION — run these BEFORE committing to the change
-- ============================================================================
--
-- #1 How many messages will the backfill map, and how many cannot be mapped?
--    SELECT count(*) filter (where m.customer_id is not null)  as already_mapped,
--           count(*) filter (where m.customer_id is null
--                              and b.customer_id is not null) as to_backfill,
--           count(*) filter (where b.customer_id is null)     as unmappable_guest
--      FROM public.booking_messages m
--      LEFT JOIN public.bookings b ON b.id = m.booking_id;
--
--    Expect `unmappable_guest` to match the count of messages on guest walk-in
--    bookings (customer_id IS NULL). Those are intentionally excluded from
--    threads. If `unmappable_guest` is unexpectedly large, stop and investigate
--    before applying.
--
-- #2 Confirm the per-customer thread sizes look sane (a customer should now own
--    the SUM of their bookings, not one thread each):
--    SELECT b.customer_id, count(*) AS messages
--      FROM public.booking_messages m
--      JOIN public.bookings b ON b.id = m.booking_id
--     WHERE b.customer_id IS NOT NULL
--     GROUP BY b.customer_id
--     ORDER BY messages DESC
--     LIMIT 20;
--
-- #3 List the LIVE Row Level Security policies on booking_messages and confirm
--    each one still resolves for a customer_id-scoped read:
--    SELECT policyname, cmd, qual, with_check
--      FROM pg_policies
--     WHERE schemaname = 'public' AND tablename = 'booking_messages';
--
-- #4 Confirm the built-in tombstone column is present and correctly typed:
--    SELECT column_name, data_type, column_default, is_nullable
--      FROM information_schema.columns
--     WHERE table_schema = 'public'
--       AND table_name = 'business_config'
--       AND column_name = 'archived_service_ids';


-- ============================================================================
-- ROLLBACK — if the change must be reverted
-- ============================================================================
--
-- Section A is intentionally non-destructive, so a rollback is a matter of
-- ignoring the new column rather than restoring deleted data:
--
--   drop trigger if exists trg_set_booking_message_customer on public.booking_messages;
--   drop function if exists public.set_booking_message_customer();
--   drop index if exists public.idx_booking_messages_customer_created;
--   drop index if exists public.idx_booking_messages_customer_unread;
--   -- Optional: drop the column entirely (loses the backfill, keeps all rows).
--   -- alter table public.booking_messages drop column if exists customer_id;
--
-- To restore the old NOT NULL booking_id constraint you MUST first re-attribute
-- every NULL-tagged message, or the constraint will fail:
--   -- delete from public.booking_messages where booking_id is null;
--   -- alter table public.booking_messages alter column booking_id set not null;
--
-- Section B rollback:
--   alter table public.business_config drop constraint if exists business_config_archived_service_ids_is_array;
--   alter table public.business_config drop column if exists archived_service_ids;
--   -- WARNING: dropping the column un-suppresses every archived/deleted service;
--   -- the built-ins will reappear in the catalog on the next load.
-- ============================================================================
-- SECURITY FOLLOW-UP — NOT APPLIED BY THIS SCRIPT
-- ============================================================================
--
-- Finding (from the live policy dump, confirmed):
--
--     CREATE POLICY "Authenticated users can access booking messages"
--       ON public.booking_messages AS PERMISSIVE FOR ALL TO authenticated
--       USING (true) WITH CHECK (true);
--
-- `authenticated` is granted to EVERY signed-in user, so this policy allows any
-- customer to SELECT the entire booking_messages table — every other customer's
-- conversation — and to INSERT/UPDATE/DELETE rows belonging to anyone. Combined
-- with the Item 2 client change (thread reads and realtime subscriptions keyed on
-- `customer_id`), it is now trivially reachable: a tampered client only has to
-- request a different customer_id.
--
-- WHY IT IS NOT FIXED IN THIS MIGRATION:
--   This is a behavioural change to authorization. Applied carelessly it can lock
--   out legitimate flows — admin and staff threads, the realtime subscription, and
--   the system rows written with a NULL customer_id (guest walk-ins). That needs
--   its own review window, not a blind edit hours before the alpha test.
--
-- RECOMMENDED FIX (review, then run as its own migration):
--
--   drop policy if exists "Authenticated users can access booking messages"
--     on public.booking_messages;
--
--   create policy "Participants can read their booking messages"
--     on public.booking_messages
--     for select
--     to authenticated
--     using (
--       customer_id = auth.uid()                                     -- the customer's own thread
--       or sender_id = auth.uid()                                    -- anything I wrote
--       or exists (                                                  -- admin / staff oversight
--            select 1 from public.profiles p
--             where p.id = auth.uid()
--               and upper(coalesce(p.role, '')) in ('ADMIN', 'STAFF')
--          )
--     );
--
--   create policy "Participants can send booking messages"
--     on public.booking_messages
--     for insert
--     to authenticated
--     with check (
--       sender_id = auth.uid()                                       -- must send as yourself
--       and (
--         customer_id = auth.uid()
--         or exists (
--              select 1 from public.profiles p
--               where p.id = auth.uid()
--                 and upper(coalesce(p.role, '')) in ('ADMIN', 'STAFF')
--            )
--       )
--     );
--
--   create policy "Participants can mark messages read"
--     on public.booking_messages
--     for update
--     to authenticated
--     using (
--       customer_id = auth.uid()
--       or sender_id = auth.uid()
--       or exists (
--            select 1 from public.profiles p
--             where p.id = auth.uid()
--               and upper(coalesce(p.role, '')) in ('ADMIN', 'STAFF')
--          )
--     )
--     with check (true);
--
-- BEFORE RUNNING THE FIX, verify each of these still works end to end:
--   1. Customer opens their own thread and reads history.
--   2. Customer sends a message (INSERT satisfies the WITH CHECK).
--   3. Admin opens a customer thread from the launcher and reads it.
--   4. Admin sends a message (sender_id = the admin's own id).
--   5. A system row written by a SECURITY DEFINER function still lands
--      (SECURITY DEFINER bypasses RLS, so this should be unaffected).
--   6. Realtime: a customer's channel receives a message on their own thread.
--   7. Negative test: customer A cannot read customer B's thread.
--
-- NOTE: the policies above assume `sender_id` is NOT NULL, which matches the
-- schema. Overload 1 of process_booking_refund() inserts sender_id = NULL and is
-- therefore already failing independently of RLS — fix that separately (see A.6).