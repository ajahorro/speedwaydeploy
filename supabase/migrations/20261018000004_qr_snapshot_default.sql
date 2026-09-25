-- ============================================================================
-- Batch 1 — Scenario 8: Ghost QR Code Swap (default-freeze the QR version)
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The customer sits on checkout for 5 minutes; the admin opens Settings and
-- updates the store's Payment QR image; the customer scans the OLD QR still on
-- their screen, pays, and uploads the receipt.
--
-- The client now freezes the QR target onto the booking at creation
-- (active_qr_snapshot / qr_snapshot_version). But a booking created by an older
-- client build — or any path that omits the snapshot — wrote NULL, and every
-- reader then fell back to the LIVE config, so a receipt paid against the
-- superseded QR silently validated against the NEW account and the mismatch was
-- never surfaced.
--
-- This migration adds a server-side DEFAULT: when a booking is created without a
-- QR snapshot, the master row is stamped with the CURRENT live QR config and its
-- version. Combined with the OCR version-mismatch flag (backend/server.js) and
-- the recipient-name gate, a receipt can never be matched to a QR the shop was
-- not displaying when the booking was taken.
-- ============================================================================

create or replace function public.default_qr_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg jsonb;
begin
  -- Only fill a genuinely-absent snapshot; never overwrite a client-provided one.
  if new.active_qr_snapshot is not null then
    return new;
  end if;

  select jsonb_build_object(
           'qr_account_name', qr_account_name,
           'qr_account_number', qr_account_number,
           'payment_qr_url', coalesce(payment_qr_url, gcash_qr_url, qr_photo_url),
           'gcash_qr_url', coalesce(gcash_qr_url, payment_qr_url, qr_photo_url),
           'qr_photo_url', coalesce(qr_photo_url, payment_qr_url, gcash_qr_url),
           'qr_config_version', coalesce(qr_config_version, 1),
           'captured_at', now()
         )
    into v_cfg
    from public.business_config
   order by id
   limit 1;

  if v_cfg is not null then
    new.active_qr_snapshot := v_cfg;
    if new.qr_snapshot_version is null then
      new.qr_snapshot_version := coalesce((v_cfg ->> 'qr_config_version')::integer, 1);
    end if;
  end if;

  return new;
end;
$$;

comment on function public.default_qr_snapshot() is
  'Scenario 8: stamps a booking with the CURRENT QR config when no snapshot was supplied, so an old client cannot leave active_qr_snapshot NULL and fall back to a later, swapped live QR.';

drop trigger if exists trg_default_qr_snapshot on public.bookings;
create trigger trg_default_qr_snapshot
  before insert on public.bookings
  for each row
  execute function public.default_qr_snapshot();

-- Backfill: existing upcoming (non-terminal) bookings with no snapshot adopt the
-- current config version so their settlement has a concrete frozen target.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bookings' and column_name = 'active_qr_snapshot'
  ) then
    update public.bookings b
       set active_qr_snapshot = jsonb_build_object(
             'qr_account_name', c.qr_account_name,
             'qr_account_number', c.qr_account_number,
             'payment_qr_url', coalesce(c.payment_qr_url, c.gcash_qr_url, c.qr_photo_url),
             'gcash_qr_url', coalesce(c.gcash_qr_url, c.payment_qr_url, c.qr_photo_url),
             'qr_photo_url', coalesce(c.qr_photo_url, c.payment_qr_url, c.gcash_qr_url),
             'qr_config_version', coalesce(c.qr_config_version, 1),
             'captured_at', now()
           ),
           qr_snapshot_version = coalesce(b.qr_snapshot_version, c.qr_config_version, 1)
      from public.business_config c
     where b.active_qr_snapshot is null
       and lower(coalesce(b.status, '')) not in ('cancelled', 'completed', 'released', 'flagged_noshow');
  end if;
end $$;