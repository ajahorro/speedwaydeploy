-- ============================================================================
-- Clear every stored payment reference number.
--
-- Run this AFTER scripts/sql/reset-bookings-clean-slate.sql (which already removes
-- the payments of deleted bookings and their scan sessions), in the Supabase
-- SQL Editor. One transaction: if anything fails, nothing changes.
--
-- Removes, everywhere they exist:
--   * every receipt scan session (the saved image fingerprint + what was read);
--   * payments.reference_number, payments.detected_ref and payments.ocr_text
--     (the text read from the receipt contains the same reference);
--   * the reference/raw text inside bookings.ocr_metadata.
--
-- KEEPS: accounts, services, Business Hub configuration, audit logs (their text
-- is history and is left as written), and the internal keys of system-made
-- refunds (method SYSTEM_REFUND). Those are not receipt references; they are
-- what stops the same refund being issued twice.
--
-- THIS CANNOT BE UNDONE. Take a backup first.
-- Going forward the app saves a reference only when a booking is actually made
-- with it (migration 20261030000001 and the backend change that ships with it).
-- ============================================================================
begin;

-- Preview
select 'receipt scan sessions' as what, count(*) as rows_affected from public.ocr_scan_sessions
union all select 'payments with a reference or OCR text', count(*) from public.payments
  where method is distinct from 'SYSTEM_REFUND'
    and (reference_number is not null or detected_ref is not null or ocr_text is not null)
union all select 'bookings with OCR metadata', count(*) from public.bookings
  where ocr_metadata ?| array['referenceNumber', 'referenceNo', 'rawText', 'ocrText'];

delete from public.ocr_scan_sessions;

update public.payments
   set reference_number = null,
       detected_ref = null,
       ocr_text = null
 where method is distinct from 'SYSTEM_REFUND'
   and (reference_number is not null or detected_ref is not null or ocr_text is not null);

update public.bookings
   set ocr_metadata = ocr_metadata - 'referenceNumber' - 'referenceNo' - 'rawText' - 'ocrText'
 where ocr_metadata ?| array['referenceNumber', 'referenceNo', 'rawText', 'ocrText'];

-- Verify (all zero)
select 'receipt scan sessions left' as what, count(*) as remaining from public.ocr_scan_sessions
union all select 'payments still holding a reference/OCR text', count(*) from public.payments
  where method is distinct from 'SYSTEM_REFUND'
    and (reference_number is not null or detected_ref is not null or ocr_text is not null)
union all select 'bookings still holding a reference in OCR metadata', count(*) from public.bookings
  where ocr_metadata ?| array['referenceNumber', 'referenceNo', 'rawText', 'ocrText'];

commit;

-- Receipt photos in the payment-receipts storage bucket are separate files; empty
-- that bucket from Dashboard > Storage if you want them gone too.
