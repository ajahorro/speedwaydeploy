-- ============================================================================
-- Receipt scans that never became a booking leave nothing behind.
--
-- A scan creates an ocr_scan_sessions row (image hash + what was read, including
-- the reference number) that lives for 20 minutes and is "consumed" when a
-- booking is created from it. Rows that were never consumed were never deleted,
-- so they accumulated, and worse, an unconsumed row blocked the same photo from
-- being scanned again, which wrongly treated a customer's own retry as a reused
-- receipt.
--
-- Now:
--   * registering a scan first deletes every unconsumed session that has
--     expired, and any unconsumed session for the SAME image (a retry replaces
--     it), so stale scans are cleaned up as a side effect of normal use;
--   * a photo is only "already used" when it belongs to a booking.
--
-- Consumed sessions (the ones tied to a real booking and payment) are kept: they
-- are the record that prevents the same receipt being reused.
-- ============================================================================
create or replace function public.register_ocr_scan_session(
  p_image_hash text,
  p_ocr_metadata jsonb,
  p_payment_verdict text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_image_hash is null or p_image_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid OCR image hash';
  end if;
  if p_payment_verdict <> 'FOR_VERIFICATION' then
    raise exception 'Unsupported OCR scan verdict';
  end if;

  -- Housekeeping: scans that never turned into a booking.
  delete from public.ocr_scan_sessions
   where booking_id is null
     and payment_id is null
     and (expires_at < now() or image_hash = p_image_hash);

  -- Only an image that already belongs to a booking is "used".
  if exists (
    select 1
      from public.ocr_scan_sessions
     where image_hash = p_image_hash
       and (booking_id is not null or payment_id is not null)
  ) then
    raise exception 'RECEIPT_IMAGE_ALREADY_USED'
      using errcode = '23505';
  end if;

  insert into public.ocr_scan_sessions (
    image_hash, ocr_metadata, payment_verdict, active, expires_at
  ) values (
    p_image_hash,
    coalesce(p_ocr_metadata, '{}'::jsonb) || jsonb_build_object('image_hash', p_image_hash),
    p_payment_verdict,
    true,
    now() + interval '20 minutes'
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_ocr_scan_session(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.register_ocr_scan_session(text, jsonb, text) to service_role;
