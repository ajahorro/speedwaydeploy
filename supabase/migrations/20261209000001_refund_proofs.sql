-- Proof of refund.
--
-- When an administrator refunds a customer, they upload the proof of that refund (for a bank transfer, the transfer
-- screenshot; for cash, a photo of the signed cash-out slip). The backend reads the image for a reference number and
-- refuses a reference or an image that has been used before; then it stores the image privately and records it here.
-- The customer and the administrator see it next to the refund in the booking and in the financial ledger.
--
--   * One proof belongs to one refund record (booking + the refund's RFD- reference).
--   * A refund cannot be recorded without its proof (rule on payments below).
--   * Only the backend (service account) can add or remove proofs; the customer of the booking and administrators can read.

create table if not exists public.refund_proofs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  refund_reference text not null,            -- the RFD- reference of the refund record this proof backs
  storage_path text not null,                -- file in the private refund-proofs bucket: <booking_id>/<file>
  proof_reference text,                      -- reference number read from the proof (empty only for a cash refund with none)
  image_hash text not null,                  -- fingerprint of the image, so the same picture cannot be used twice
  refund_method text,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint refund_proofs_one_per_refund unique (booking_id, refund_reference),
  constraint refund_proofs_image_unique unique (image_hash)
);
create unique index if not exists refund_proofs_reference_unique on public.refund_proofs (upper(proof_reference)) where proof_reference is not null;
create index if not exists refund_proofs_booking_idx on public.refund_proofs (booking_id);

alter table public.refund_proofs enable row level security;
revoke all on public.refund_proofs from anon, authenticated;
grant select on public.refund_proofs to authenticated;
grant all on public.refund_proofs to service_role;

drop policy if exists refund_proofs_read_admin on public.refund_proofs;
create policy refund_proofs_read_admin on public.refund_proofs for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and upper(p.role) = 'ADMIN'));

drop policy if exists refund_proofs_read_customer on public.refund_proofs;
create policy refund_proofs_read_customer on public.refund_proofs for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = refund_proofs.booking_id and b.customer_id = (select auth.uid())));

-- A reference read from a refund proof must not be one a customer already used to pay.
create or replace function public.refund_proof_reference_not_a_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.proof_reference is not null and exists (
    select 1 from public.payments p
     where p.method is distinct from 'SYSTEM_REFUND'
       and (upper(p.reference_number) = upper(new.proof_reference) or upper(p.detected_ref) = upper(new.proof_reference))
  ) then
    raise exception 'REFERENCE_REUSED: reference % was already used on a payment', new.proof_reference using errcode = '23505';
  end if;
  return new;
end;
$$;
drop trigger if exists refund_proofs_reference_not_a_payment on public.refund_proofs;
create trigger refund_proofs_reference_not_a_payment before insert on public.refund_proofs
  for each row execute function public.refund_proof_reference_not_a_payment();

-- A refund cannot be recorded without its proof.
create or replace function public.require_refund_proof()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.method = 'SYSTEM_REFUND' and coalesce(new.amount, 0) < 0 then
    if not exists (
      select 1 from public.refund_proofs rp
       where rp.booking_id = new.booking_id and rp.refund_reference = new.reference_number
    ) then
      raise exception 'REFUND_PROOF_REQUIRED: upload the proof of refund before the refund is processed.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists payments_require_refund_proof on public.payments;
create trigger payments_require_refund_proof before insert on public.payments
  for each row execute function public.require_refund_proof();

-- Proofs that were uploaded but never used for a refund (the refund was not completed). The backend clears them.
create or replace function public.refund_proofs_without_refund(p_older_than interval default interval '1 day')
returns table (id uuid, storage_path text)
language sql
stable
security definer
set search_path = public
as $$
  select rp.id, rp.storage_path
    from public.refund_proofs rp
   where rp.created_at < now() - p_older_than
     and not exists (
       select 1 from public.payments p
        where p.booking_id = rp.booking_id and p.method = 'SYSTEM_REFUND' and p.reference_number = rp.refund_reference
     )
   order by rp.created_at
   limit 200;
$$;
revoke all on function public.refund_proofs_without_refund(interval) from public, anon, authenticated;
grant execute on function public.refund_proofs_without_refund(interval) to service_role;

-- The private bucket. Files are written by the backend only; the customer of the booking and administrators may read.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('refund-proofs', 'refund-proofs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "refund_proofs_read_scoped" on storage.objects;
create policy "refund_proofs_read_scoped" on storage.objects for select to authenticated
  using (
    bucket_id = 'refund-proofs'
    and (
      exists (select 1 from public.bookings b where b.id::text = (storage.foldername(name))[1] and b.customer_id = (select auth.uid()))
      or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and upper(p.role) = 'ADMIN')
    )
  );
