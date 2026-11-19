-- The payment-receipts and receipts buckets were restricted to the "image/*" wildcard, which still
-- admits image/svg+xml. An SVG can carry a <script> that runs if the file is ever opened directly
-- (a top-level navigation or an <object>/<iframe> embed) rather than through the app's own <img>
-- rendering. Narrow both buckets to the same raster-only allowlist already used for refund proofs.
update storage.buckets
   set allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','image/heif']
 where id in ('payment-receipts', 'receipts')
   and allowed_mime_types = array['image/*'];
