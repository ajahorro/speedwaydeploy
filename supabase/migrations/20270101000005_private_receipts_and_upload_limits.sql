-- Payment receipts and chat attachments are no longer open to anyone with the link: the app now shows them through
-- links that expire after an hour (backend /api/files/sign). Uploads are limited to pictures (and PDF in chat)
-- of a sensible size.
update storage.buckets set public = false, file_size_limit = 10485760, allowed_mime_types = array['image/*']
 where id in ('payment-receipts', 'receipts');
update storage.buckets set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/*', 'application/pdf']
 where id = 'chat_media';
