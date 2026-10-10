/**
 * Proof of refund.
 *
 * The administrator uploads a picture that proves the refund was paid (a bank transfer screenshot, or a photo of a
 * signed cash-out slip). The picture is read for a reference number and must follow the same rule as a payment
 * receipt: a reference number is single-use, and so is the picture itself. The picture is then stored privately and
 * recorded against the refund (booking + the refund's RFD- reference), where the customer and administrators can see it.
 */
const ocrGuard = require('./ocrGuard');

const BUCKET = 'refund-proofs';
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };

// "4821 556 019283" and "4821556019283" are the same reference.
const normalizeProofReference = (value) => String(value || '').replace(/\s+/g, '').toUpperCase();

/**
 * Why this proof cannot be used, or null when it is fine. Looks at: reference numbers on other refund proofs and on any
 * payment, and the picture itself on other refund proofs and on payment receipts already attached to a booking.
 * `refundReference` of the proof being replaced is ignored, so re-uploading for the same refund is allowed.
 */
const findProofConflict = async (supabase, { reference, imageHash, bookingId, refundReference }) => {
  const isSameRefund = (row) => row.booking_id === bookingId && row.refund_reference === refundReference;

  if (reference) {
    const { data: proofs, error } = await supabase.from('refund_proofs').select('booking_id, refund_reference').eq('proof_reference', reference);
    if (error) throw error;
    if ((proofs || []).some((row) => !isSameRefund(row))) return 'REFERENCE_REUSED';
    const { data: payments, error: paymentError } = await supabase
      .from('payments')
      .select('id')
      .or(`reference_number.ilike.${reference},detected_ref.ilike.${reference}`)
      .limit(1);
    if (paymentError) throw paymentError;
    if ((payments || []).length) return 'REFERENCE_REUSED';
  }

  const { data: sameImage, error: imageError } = await supabase.from('refund_proofs').select('booking_id, refund_reference').eq('image_hash', imageHash);
  if (imageError) throw imageError;
  if ((sameImage || []).some((row) => !isSameRefund(row))) return 'IMAGE_REUSED';

  try {
    const { data: sessions, error: sessionError } = await supabase.from('ocr_scan_sessions').select('id').eq('image_hash', imageHash).not('booking_id', 'is', null).limit(1);
    if (!sessionError && (sessions || []).length) return 'IMAGE_REUSED';
  } catch {
    // the receipt scan log is optional: its absence never blocks a refund proof
  }
  return null;
};

const refundAlreadyRecorded = async (supabase, bookingId, refundReference) => {
  const { data, error } = await supabase
    .from('payments').select('id').eq('booking_id', bookingId).eq('method', 'SYSTEM_REFUND').eq('reference_number', refundReference).limit(1);
  if (error) throw error;
  return (data || []).length > 0;
};

/** Removes the not-yet-used proof of this refund (file first, then record). */
const discardPendingProof = async (supabase, bookingId, refundReference) => {
  const { data: existing, error } = await supabase.from('refund_proofs').select('id, storage_path').eq('booking_id', bookingId).eq('refund_reference', refundReference);
  if (error) throw error;
  for (const row of existing || []) {
    const { error: removeError } = await supabase.storage.from(BUCKET).remove([row.storage_path]);
    if (removeError) throw removeError;
    const { error: deleteError } = await supabase.from('refund_proofs').delete().eq('id', row.id);
    if (deleteError) throw deleteError;
  }
  return (existing || []).length;
};

/** Stores the picture and records the proof. Any earlier unused proof for the same refund is replaced. */
const storeProof = async (supabase, { bookingId, refundReference, reference, imageHash, buffer, mimetype, refundMethod, uploadedBy }) => {
  await discardPendingProof(supabase, bookingId, refundReference);
  const extension = EXTENSIONS[mimetype] || 'img';
  const storagePath = `${bookingId}/${refundReference}-${imageHash.slice(0, 10)}.${extension}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, { contentType: mimetype || 'application/octet-stream', upsert: false });
  if (uploadError) throw uploadError;
  const { data, error } = await supabase.from('refund_proofs').insert({
    booking_id: bookingId,
    refund_reference: refundReference,
    storage_path: storagePath,
    proof_reference: reference || null,
    image_hash: imageHash,
    refund_method: refundMethod || null,
    uploaded_by: uploadedBy || null
  }).select('id, proof_reference').single();
  if (error) {
    await supabase.storage.from(BUCKET).remove([storagePath]);
    throw error;
  }
  return { id: data.id, reference: data.proof_reference, storagePath };
};

/** Proofs uploaded for a refund that was never completed are cleared after a day. */
const purgeOrphanRefundProofs = async (supabase, { olderThan = '1 day' } = {}) => {
  const { data: orphans, error } = await supabase.rpc('refund_proofs_without_refund', { p_older_than: olderThan });
  if (error) throw error;
  if (!orphans || !orphans.length) return { records: 0 };
  const { error: removeError } = await supabase.storage.from(BUCKET).remove(orphans.map((row) => row.storage_path));
  if (removeError) throw removeError;
  const { error: deleteError } = await supabase.from('refund_proofs').delete().in('id', orphans.map((row) => row.id));
  if (deleteError) throw deleteError;
  return { records: orphans.length };
};

module.exports = {
  BUCKET,
  EXTENSIONS,
  computeImageHash: ocrGuard.computeImageHash,
  normalizeProofReference,
  findProofConflict,
  refundAlreadyRecorded,
  discardPendingProof,
  storeProof,
  purgeOrphanRefundProofs
};
