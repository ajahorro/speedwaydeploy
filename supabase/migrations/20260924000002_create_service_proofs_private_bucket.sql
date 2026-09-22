-- ============================================================================
-- Batch 5 / Step 1 (2 of 3) — Private `service-proofs` storage bucket + RLS
-- ============================================================================
--
-- Creates the PRIVATE bucket that backs public.service_photos and the storage
-- RLS policies that scope object access.
--
-- Security model (approved):
--   * Private bucket (public = false). Objects are never directly reachable.
--   * Reads are gated by RLS. The application mints SHORT-LIVED signed URLs
--     (15 min) at render time; no root path or public link is persisted.
--   * Object path convention (enforced by policy using storage.foldername):
--         <booking_id>/<booking_vehicle_id>/<phase>/<uuid>.<ext>
--     The FIRST folder segment is the booking_id, which the policies use to
--     resolve ownership without a join on the object metadata.
--
-- These are the first storage policies captured in a migration for this
-- project — the existing buckets (receipts / payment-receipts / chat_media)
-- were configured out-of-band. Versioning them here keeps a fresh environment
-- reproducible.
-- ============================================================================

-- ── 1. Create the private bucket ────────────────────────────────────────────
-- Idempotent: only inserted when absent, so environments that already created
-- it manually converge to the same definition.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'service-proofs',
  'service-proofs',
  false,                          -- PRIVATE
  10485760,                       -- 10 MB per object
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 2. Storage RLS policies ─────────────────────────────────────────────────
-- storage.objects already has RLS enabled by Supabase. We only add policies
-- scoped to this bucket (bucket_id = 'service-proofs') so we never widen access
-- to the other buckets.
--
-- Path parsing helper: (storage.foldername(name))[1] is the booking_id segment.

-- READ: the owning customer, the assigned staff member, or an admin.
drop policy if exists "service_proofs_read_scoped" on storage.objects;
create policy "service_proofs_read_scoped"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'service-proofs'
    and (
      exists (
        select 1
        from public.bookings b
        where b.id::text = (storage.foldername(name))[1]
          and (
            b.customer_id = auth.uid()
            or b.staff_id = auth.uid()
          )
      )
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and upper(p.role) = 'ADMIN'
      )
    )
  );

-- INSERT: assigned staff, any staff, or admins may upload evidence.
drop policy if exists "service_proofs_insert_scoped" on storage.objects;
create policy "service_proofs_insert_scoped"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'service-proofs'
    and (
      exists (
        select 1
        from public.bookings b
        where b.id::text = (storage.foldername(name))[1]
          and b.staff_id = auth.uid()
      )
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and upper(p.role) in ('STAFF', 'ADMIN')
      )
    )
  );

-- UPDATE: admins only (e.g. metadata/caption adjustments). Staff uploads create
-- new immutable objects rather than mutating existing ones.
drop policy if exists "service_proofs_update_admin" on storage.objects;
create policy "service_proofs_update_admin"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'service-proofs'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and upper(p.role) = 'ADMIN'
    )
  )
  with check (
    bucket_id = 'service-proofs'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and upper(p.role) = 'ADMIN'
    )
  );

-- DELETE: admins only. The retention purge job runs as service_role and
-- bypasses RLS, so it needs no policy here.
drop policy if exists "service_proofs_delete_admin" on storage.objects;
create policy "service_proofs_delete_admin"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'service-proofs'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and upper(p.role) = 'ADMIN'
    )
  );
