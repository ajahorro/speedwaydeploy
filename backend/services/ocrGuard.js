/**
 * ocrGuard.js
 * ============================================================================
 * Hardening for the OCR receipt pipeline, addressing three verified defects:
 *
 *   SC-17  IMAGE-HASH BYPASS (BOUNDED FIX). Dedupe was keyed ONLY on the
 *          OCR-extracted `reference_number`, a value an attacker controls, so the
 *          same image could fund two bookings. We now hash the uploaded BYTES.
 *
 *          ⚠️ SCOPE — this is a BYTE-LEVEL SHA-256, NOT a perceptual hash.
 *          It catches the realistic attack (re-uploading the EXACT same file,
 *          e.g. a saved screenshot) because identical bytes collide. It does
 *          NOT catch a re-encoded/re-photographed copy: SC-17B proves that a
 *          phone screenshot of the same receipt produces DIFFERENT bytes and
 *          therefore a DIFFERENT hash, so it slips past this gate. Catching
 *          that needs a true perceptual (pHash/dHash) pipeline, which requires
 *          an image decoder (sharp/jimp) — intentionally not added here to keep
 *          the deployment dependency-free. See SC-17B in the test suite.
 *
 *   SC-18  OCR RATE-LIMIT DRAIN. There was no server-side throttle, so a script
 *          could fire unlimited scans and drain 3rd-party OCR credits. We add a
 *          per-identity sliding-window limiter (default: 8 scans / 5 min) plus a
 *          consecutive-failure circuit breaker that locks automated OCR and
 *          forces the payment into manual review.
 *
 *   SC-8   MIDNIGHT DATE REJECTION. A receipt dated 11:58 PM uploaded at 12:02 AM
 *          failed the strict same-calendar-day check and valid money was rejected.
 *          We replace it with a symmetric time WINDOW (default: ±24 h), so a
 *          receipt from just before midnight still verifies after the rollover.
 * ============================================================================
 */

const crypto = require('crypto');

// ── SC-17: BYTE-LEVEL hash of the raw upload ────────────────────────────────
// ⚠️ This is SHA-256 over the raw bytes — deliberately NOT a perceptual hash.
// It reliably detects a re-upload of the IDENTICAL file (the common "same
// screenshot twice" case) regardless of the reference number. It does NOT
// detect a re-encoded/re-photographed copy of the same receipt; that requires
// an image decoder and a pixel-space pHash. See the SCOPE note in the header.
const computeImageHash = (buffer) => {
  if (!buffer || !buffer.length) return null;
  return crypto.createHash('sha256').update(buffer).digest('hex');
};

// ── SC-18: sliding-window rate limiter + failure circuit breaker ────────────
const RATE_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes
const MAX_SCANS_PER_WINDOW = 8;         // per identity
const FAILURE_LOCK_THRESHOLD = 4;       // consecutive failures -> lock automation

const scanLog = new Map();     // identity -> [timestamps]
const failureLog = new Map();  // identity -> { count, lockedUntil }

const pruneWindow = (timestamps, now) => (timestamps || []).filter((t) => now - t < RATE_WINDOW_MS);

/**
 * Records a scan attempt for `identity` and reports whether it is allowed.
 * Returns { allowed, remaining, retryAfterMs }.
 */
const checkRateLimit = (identity, now = Date.now()) => {
  const key = String(identity || 'anonymous');
  const recent = pruneWindow(scanLog.get(key), now);

  if (recent.length >= MAX_SCANS_PER_WINDOW) {
    scanLog.set(key, recent);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: RATE_WINDOW_MS - (now - recent[0]),
    };
  }

  recent.push(now);
  scanLog.set(key, recent);
  return { allowed: true, remaining: MAX_SCANS_PER_WINDOW - recent.length, retryAfterMs: 0 };
};

/**
 * Whether automated OCR is currently LOCKED for this identity after repeated
 * failures. A locked identity must be routed to manual admin review.
 */
const isAutomationLocked = (identity, now = Date.now()) => {
  const record = failureLog.get(String(identity || 'anonymous'));
  if (!record) return false;
  if (record.lockedUntil && record.lockedUntil > now) return true;
  if (record.lockedUntil && record.lockedUntil <= now) {
    failureLog.delete(String(identity || 'anonymous'));
  }
  return false;
};

/** Register a successful scan: clears the failure streak. */
const recordSuccess = (identity) => {
  failureLog.delete(String(identity || 'anonymous'));
};

/**
 * Register a failed/ambiguous scan (blurry photo, unreadable receipt). After
 * FAILURE_LOCK_THRESHOLD consecutive failures the identity is locked out of
 * automated OCR for the rest of the window and must be manually verified.
 */
const recordFailure = (identity, now = Date.now()) => {
  const key = String(identity || 'anonymous');
  const record = failureLog.get(key) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= FAILURE_LOCK_THRESHOLD) {
    record.lockedUntil = now + RATE_WINDOW_MS;
  }
  failureLog.set(key, record);
  return { locked: record.lockedUntil > now, failures: record.count };
};

// ── SC-8: tolerant receipt-date validation ──────────────────────────────────
const DEFAULT_DATE_TOLERANCE_HOURS = 24;

/**
 * @param {Date|null} receiptDate  parsed receipt timestamp
 * @param {Date}      [now]        current time
 * @param {number}    [toleranceHours]
 * @returns {{ ok: boolean, reason: string, ageHours: number|null }}
 */
const receiptDateWithinTolerance = (receiptDate, now = new Date(), toleranceHours = DEFAULT_DATE_TOLERANCE_HOURS) => {
  if (!receiptDate || Number.isNaN(receiptDate.getTime())) {
    return { ok: false, reason: 'NO_DATE', ageHours: null };
  }

  const ageMs = now.getTime() - receiptDate.getTime();
  const ageHours = ageMs / 3600000;

  // A receipt dated meaningfully in the FUTURE is never valid proof.
  if (ageHours < -toleranceHours) {
    return { ok: false, reason: 'FUTURE_DATED', ageHours };
  }

  // A receipt from just before midnight (uploaded after the rollover) is now
  // ACCEPTED as long as it falls inside the symmetric window.
  if (ageHours > toleranceHours) {
    return { ok: false, reason: 'STALE', ageHours };
  }

  return { ok: true, reason: 'WITHIN_TOLERANCE', ageHours };
};

module.exports = {
  computeImageHash,
  checkRateLimit,
  isAutomationLocked,
  recordSuccess,
  recordFailure,
  receiptDateWithinTolerance,
  RATE_WINDOW_MS,
  MAX_SCANS_PER_WINDOW,
  FAILURE_LOCK_THRESHOLD,
  DEFAULT_DATE_TOLERANCE_HOURS,
};