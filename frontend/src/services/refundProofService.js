/**
 * Proof of refund: the picture the administrator uploads to show a refund was paid.
 * The backend reads it for a reference number, refuses repeats, stores it privately and records it against the
 * refund (booking + the refund's RFD- reference). The customer of the booking and administrators can read it.
 */
import { supabase } from '../lib/supabase';
import { BACKEND_URL, authHeaders } from '../config/api';
import { logger } from '../utils/logger';

export const REFUND_PROOF_BUCKET = 'refund-proofs';
export const REFUND_PROOF_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
export const MAX_REFUND_PROOF_BYTES = 10 * 1024 * 1024;

export const refundProofKey = (bookingId, refundReference) => `${bookingId}:${refundReference}`;

/** The proofs of these bookings, as a Map keyed by refundProofKey(booking, refund reference). */
export const fetchRefundProofs = async (bookingIds = []) => {
  const ids = [...new Set((bookingIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from('refund_proofs')
    .select('id, booking_id, refund_reference, storage_path, proof_reference, refund_method, created_at')
    .in('booking_id', ids);
  if (error) {
    logger.warn('Could not load proofs of refund', error);
    return new Map();
  }
  return new Map((data || []).map((row) => [refundProofKey(row.booking_id, row.refund_reference), row]));
};

/** A short-lived link to the private picture (15 minutes). */
export const refundProofUrl = async (storagePath) => {
  const { data, error } = await supabase.storage.from(REFUND_PROOF_BUCKET).createSignedUrl(storagePath, 15 * 60);
  if (error || !data?.signedUrl) throw error || new Error('The proof could not be opened.');
  return data.signedUrl;
};

/** Sends the picture to be checked and stored. Resolves { ok, proof } or { ok: false, code, error }. */
export const uploadRefundProof = async ({ bookingId, refundReference, refundMethod, file }) => {
  const form = new FormData();
  form.append('bookingId', bookingId);
  form.append('refundReference', refundReference);
  form.append('refundMethod', refundMethod);
  form.append('proof', file);
  const headers = await authHeaders();
  delete headers['Content-Type']; // the browser sets the multipart boundary
  try {
    const response = await fetch(`${BACKEND_URL}/api/admin/refunds/proof`, { method: 'POST', headers, body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) return { ok: false, code: body.code || 'FAILED', error: body.error || 'The proof could not be checked. Please try again.' };
    return { ok: true, proof: body.proof };
  } catch {
    return { ok: false, code: 'UNREACHABLE', error: 'The server could not be reached. Check your connection and try again.' };
  }
};

/** Removes a proof that has not been used for a refund yet. */
export const discardRefundProof = async ({ bookingId, refundReference }) => {
  try {
    const response = await fetch(`${BACKEND_URL}/api/admin/refunds/proof/discard`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ bookingId, refundReference })
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && body.success !== false, error: body.error };
  } catch {
    return { ok: false, error: 'The server could not be reached.' };
  }
};
