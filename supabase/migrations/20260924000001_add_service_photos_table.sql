-- ============================================================================
-- Batch 5 / Step 1 (1 of 3) — Photo Proof Architecture: service_photos table
-- ============================================================================
--
-- Introduces the canonical photo-evidence table for the staff service workflow.
--
-- Design goals (approved Batch 5 decisions):
--   * Replace the ad-hoc `booking_vehicles.photo_proof_url` JSON-string array
--     (public URLs) with a first-class, private-bucket backed table.
--   * Distinguish an intake "before" photo from a completion "after" (QA) photo
--     via the `phase` discriminator.
--   * Store only the object `storage_path` — never a URL. Signed URLs are minted
--     at render time (short TTL) by the application, so no long-lived public
--     link is ever persisted.
--   * Carry retention state (`archived_at`, `retention_exempt`) so the two-phase
--     retention job (12mo archive -> 24mo purge) can operate on rows directly.
--
-- Backfill: any legacy `booking_vehicles.photo_proof_url` value is copied into
-- this table as `phase = 'after'` (best-effort, idempotent). The legacy column
-- is intentionally LEFT IN PLACE (read-only fallback for one release) and is not
-- dropped here.
-- ============================================================================

-- ── 1. Core table ───────────────────────────────────────────────────────────
create table if not exists public.service_photos (
  id                 uuid primary key default gen_random_uuid(),
  booking_id         uuid not null references public.bookings(id) on delete cascade,
  booking_vehicle_id uuid references public.booking_vehicles(id) on delete cascade,
  -- 'before' = intake / pre-service, 'after' = completion / QA evidence.
  phase              text not null check (phase in ('before', 'after')),
  -- Object path within the private `service-proofs` bucket. NEVER a URL.
  storage_path       text not null,
  -- Optional human context (e.g. "front bumper scratch noted at intake").
  caption            text,
  uploaded_by        uuid references public.profiles(id) on delete set null,
  uploaded_at        timestamptz not null default now(),
  -- How the row entered the system; keeps the legacy backfill auditable.
  source             text not null default 'upload' check (source in ('upload', 'legacy_backfill')),
  -- ── Retention state (two-phase) ──
  -- Set when the row crosses the 12-month archive threshold. Archived rows are
  -- hidden from the active UI but remain retrievable by an admin.
  archived_at        timestamptz,
  -- Legal hold: when true, the purge job skips this row (e.g. open dispute).
  retention_exempt   boolean not null default false
);

-- ── 2. Indexes ──────────────────────────────────────────────────────────────
create index if not exists service_photos_booking_idx
  on public.service_photos(booking_id);

create index if not exists service_photos_vehicle_idx
  on public.service_photos(booking_vehicle_id);

-- Supports the retention sweep: "which rows are old enough to archive?".
create index if not exists service_photos_retention_idx
  on public.service_photos(archived_at, uploaded_at)
  where retention_exempt = false;

-- A completion gate queries "does this booking have any 'after' photo?" — keep
-- that lookup cheap.
create index if not exists service_photos_phase_idx
  on public.service_photos(booking_id, phase);

-- ── 3. Row Level Security ───────────────────────────────────────────────────
alter table public.service_photos enable row level security;

-- Reads: the owning customer, the assigned staff member, and admins.
-- The link to the customer is via bookings.customer_id; to staff via
-- bookings.staff_id. Both are resolved through the parent booking.
drop policy if exists "service_photos_select_owner_staff_admin" on public.service_photos;
create policy "service_photos_select_owner_staff_admin"
  on public.service_photos
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.bookings b
      where b.id = service_photos.booking_id
        and (
          b.customer_id = auth.uid()
          or b.staff_id = auth.uid()
        )
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and upper(p.role) = 'ADMIN'
    )
  );

-- Writes: the assigned staff member OR any staff/admin may add photos. This is
-- the path used by the service workflow (intake + QA uploads).
drop policy if exists "service_photos_insert_staff_admin" on public.service_photos;
create policy "service_photos_insert_staff_admin"
  on public.service_photos
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.bookings b
      where b.id = service_photos.booking_id
        and b.staff_id = auth.uid()
    )
    -- Any STAFF member may contribute evidence to a booking bay; admins always.
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and upper(p.role) in ('STAFF', 'ADMIN')
    )
  );

-- Updates: admins only. Used for retention_exempt (legal hold) and captions.
drop policy if exists "service_photos_update_admin" on public.service_photos;
create policy "service_photos_update_admin"
  on public.service_photos
  for update
  to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and upper(p.role) = 'ADMIN')
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and upper(p.role) = 'ADMIN')
  );

-- Deletes: admins only. (The purge job runs as service_role and bypasses RLS.)
drop policy if exists "service_photos_delete_admin" on public.service_photos;
create policy "service_photos_delete_admin"
  on public.service_photos
  for delete
  to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and upper(p.role) = 'ADMIN')
  );

-- ── 4. Legacy backfill (best-effort, idempotent) ────────────────────────────
-- Older rows stored `photo_proof_url` on booking_vehicles as either a JSON
-- stringified array of public URLs OR a single legacy URL string. We copy each
-- URL into service_photos as phase = 'after'.
--
-- `storage_path` for backfilled rows is set to the ORIGINAL URL verbatim (it may
-- be an absolute public URL, not a bucket-relative path). The application's
-- signed-URL resolver treats values starting with 'http' as already-resolved
-- legacy links and falls back to them when no signed URL can be minted. This
-- preserves history without pretending the old object lives in the new bucket.
--
-- Idempotency: guarded by `source = 'legacy_backfill'` so re-running the
-- migration does not duplicate rows.
do $$
declare
  r record;
  parsed jsonb;
  url text;
begin
  for r in
    select bv.id as veh_id, bv.booking_id, bv.photo_proof_url, bv.updated_at
    from public.booking_vehicles bv
    where bv.photo_proof_url is not null
      and bv.photo_proof_url <> ''
      -- Skip vehicles already backfilled (idempotent re-run guard).
      and not exists (
        select 1 from public.service_photos sp
        where sp.booking_vehicle_id = bv.id
          and sp.source = 'legacy_backfill'
      )
  loop
    -- Try to parse the stored value as a JSON array; fall back to a single URL.
    begin
      parsed := r.photo_proof_url::jsonb;
    exception when others then
      parsed := null;
    end;

    if parsed is not null and jsonb_typeof(parsed) = 'array' then
      for url in select jsonb_array_elements_text(parsed)
      loop
        if url is not null and url <> '' then
          insert into public.service_photos
            (booking_id, booking_vehicle_id, phase, storage_path, source, uploaded_at)
          values
            (r.booking_id, r.veh_id, 'after', url, 'legacy_backfill',
             coalesce(r.updated_at, now()));
        end if;
      end loop;
    elsif r.photo_proof_url <> '' then
      -- Legacy single-URL string (non-JSON).
      insert into public.service_photos
        (booking_id, booking_vehicle_id, phase, storage_path, source, uploaded_at)
      values
        (r.booking_id, r.veh_id, 'after', r.photo_proof_url, 'legacy_backfill',
         coalesce(r.updated_at, now()));
    end if;
  end loop;
end $$;

-- ── 5. Documentation ────────────────────────────────────────────────────────
comment on table public.service_photos is
  'Batch 5 photo evidence. Private-bucket backed (service-proofs). Stores storage_path only; signed URLs minted at render. Two-phase retention via archived_at + retention_exempt.';
comment on column public.service_photos.phase is
  'before = intake/pre-service (soft warning), after = completion/QA (hard block to complete).';
comment on column public.service_photos.storage_path is
  'Bucket-relative object path in the private service-proofs bucket, or a legacy absolute URL for source=legacy_backfill rows.';
