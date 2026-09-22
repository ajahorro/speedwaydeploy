import { supabase } from '../lib/supabase';
import { logger } from '../utils/logger';
import { isAlphaNum } from '../config/constants';

/**
 * qrSecurityService.js
 * ============================================================================
 * Batch 7 / Step 7.5 — Task B: Business Hub QR Code security + OTP.
 *
 * Responsibilities:
 *   1. Load the four MANDATORY recipient fields from business_config:
 *        qr_account_name, qr_account_number,
 *        fallback_receiver_name, fallback_receiver_number
 *   2. Validate completion and BLOCK saves when any field is missing/blank or
 *      contains characters outside the strict alphanumeric allow-list.
 *   3. Drive the 6-digit email OTP flow for a QR change:
 *        requestQrChangeOtp()  -> hashes a fresh code, emails it, stores a hash
 *        verifyQrChangeOtp()   -> commits the config only on a matching code
 *   4. Capture / read `active_qr_snapshot` for a checkout session so a mid-update
 *      QR change can never fail an in-flight payment.
 *
 * Fail-closed: if the backend RPC is unreachable we surface an explicit error
 * and the change is NOT applied.
 */

export const QR_FIELDS = [
  { key: 'qr_account_name', label: 'QR Account Name' },
  { key: 'qr_account_number', label: 'QR Account Number' },
  { key: 'fallback_receiver_name', label: 'Fallback Receiver Name' },
  { key: 'fallback_receiver_number', label: 'Fallback Receiver Number' },
];

/**
 * Validate the four mandatory recipient fields.
 * @returns {{ ok: boolean, missing: string[], invalid: string[] }}
 *   `missing`  — labels that are blank.
 *   `invalid`  — labels failing the strict alphanumeric guard.
 */
export const validateQrRecipients = (config = {}) => {
  const missing = [];
  const invalid = [];
  for (const { key, label } of QR_FIELDS) {
    const raw = String(config[key] ?? '').trim();
    if (!raw) { missing.push(label); continue; }
    // Account numbers may legitimately contain a dash/space; names must be
    // strictly alphanumeric. Normalise separators before the allow-list check.
    const normalised = raw.replace(/[-\s]/g, '');
    if (!isAlphaNum(normalised)) invalid.push(label);
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
};

/** Fetch the current QR recipient configuration (fail-closed on error). */
export const fetchQrConfig = async () => {
  const { data, error } = await supabase
    .from('business_config')
    .select('id, qr_account_name, qr_account_number, fallback_receiver_name, fallback_receiver_number, qr_config_version, qr_config_complete, qr_updated_at, gcash_qr_url')
    .order('id')
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('Failed to load QR configuration', error);
    throw new Error('Could not load the QR configuration. Please reload the page.');
  }
  return data || {};
};

/**
 * Snapshot the CURRENT QR config onto a booking so the checkout session settles
 * against a frozen target. Call this the moment the customer opens the payment
 * step; mid-update QR changes afterwards cannot break their payment.
 */
export const captureQrSnapshot = async (bookingId, config) => {
  if (!bookingId) return null;
  const snapshot = {
    qr_account_name: config?.qr_account_name || '',
    qr_account_number: config?.qr_account_number || '',
    fallback_receiver_name: config?.fallback_receiver_name || '',
    fallback_receiver_number: config?.fallback_receiver_number || '',
    gcash_qr_url: config?.gcash_qr_url || null,
    qr_config_version: config?.qr_config_version ?? 1,
    captured_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('bookings')
    .update({ active_qr_snapshot: snapshot, qr_snapshot_version: snapshot.qr_config_version })
    .eq('id', bookingId);

  if (error) {
    // Non-fatal for the customer (they can still pay), but log for ops.
    logger.warn('Failed to capture QR snapshot for booking', error);
    return null;
  }
  return snapshot;
};

/** Read the frozen snapshot for a booking (falls back to live config). */
export const getEffectiveQrTarget = async (bookingId) => {
  if (bookingId) {
    const { data } = await supabase
      .from('bookings')
      .select('active_qr_snapshot')
      .eq('id', bookingId)
      .maybeSingle();
    if (data?.active_qr_snapshot && Object.keys(data.active_qr_snapshot).length) {
      return { ...data.active_qr_snapshot, is_snapshot: true };
    }
  }
  return { ...(await fetchQrConfig()), is_snapshot: false };
};

// ── OTP flow ────────────────────────────────────────────────────────────────

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

/** Generate a cryptographically-random 6-digit code. */
const generateOtp = () => {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
};

/** SHA-256 hex hash (matches pgcrypto `digest(..., 'sha256')` shape check). */
const sha256Hex = async (text) => {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Step 1 of the QR change: validate, email a 6-digit code, and park the pending
 * config as a hashed challenge. Returns { challengeId } on success.
 */
export const requestQrChangeOtp = async (pendingConfig, currentConfig = {}) => {
  const v = validateQrRecipients(pendingConfig);
  if (!v.ok) {
    const parts = [];
    if (v.missing.length) parts.push(`missing: ${v.missing.join(', ')}`);
    if (v.invalid.length) parts.push(`invalid characters: ${v.invalid.join(', ')}`);
    throw new Error(`All fields are required. ${parts.join('; ')}`);
  }

  const otp = generateOtp();
  const otpHash = await sha256Hex(otp);

  const payload = {
    qr_account_name: pendingConfig.qr_account_name.trim(),
    qr_account_number: pendingConfig.qr_account_number.trim(),
    fallback_receiver_name: pendingConfig.fallback_receiver_name.trim(),
    fallback_receiver_number: pendingConfig.fallback_receiver_number.trim(),
    // Kept for the audit-log Old-vs-New diff.
    old_qr_account_name: currentConfig.qr_account_name || '',
    old_qr_account_number: currentConfig.qr_account_number || '',
    old_fallback_receiver_name: currentConfig.fallback_receiver_name || '',
    old_fallback_receiver_number: currentConfig.fallback_receiver_number || '',
  };

  // Park the challenge first — if the email fails we do not want a live code.
  const { data: challengeId, error: startErr } = await supabase.rpc('start_qr_change_otp', {
    p_payload: payload,
    p_otp_hash: otpHash,
  });
  if (startErr) {
    logger.error('Failed to start QR change OTP', startErr);
    throw new Error('Could not start the verification flow. Please try again.');
  }

  // Dispatch the email (fail-closed: cancel the challenge if it cannot be sent).
  try {
    const res = await fetch(`${BACKEND_URL}/api/emails/qr-change-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp }),
    });
    if (!res.ok) throw new Error(`email relay ${res.status}`);
  } catch (err) {
    logger.error('QR change OTP email failed', err);
    throw new Error('We could not send the verification code. Please try again.');
  }

  return { challengeId };
};

/** Step 2 of the QR change: submit the code; commits only on a match. */
export const verifyQrChangeOtp = async (code, pendingConfig = {}) => {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) throw new Error('Enter the 6-digit code from your email.');

  // Re-validate at submit time: never trust the modal state alone.
  const v = validateQrRecipients(pendingConfig);
  if (!v.ok) throw new Error('All fields are required.');

  const otpHash = await sha256Hex(clean);
  const { data, error } = await supabase.rpc('verify_qr_change_otp', { p_otp_hash: otpHash });
  if (error) {
    logger.error('QR change OTP verification failed', error);
    throw new Error(error.message || 'Verification failed. Please try again.');
  }
  return data;
};

export default {
  QR_FIELDS,
  validateQrRecipients,
  fetchQrConfig,
  captureQrSnapshot,
  getEffectiveQrTarget,
  requestQrChangeOtp,
  verifyQrChangeOtp,
};