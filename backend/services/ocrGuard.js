/**
 * ocrGuard.js
 * ==========================================================================
 * Hardening for the OCR receipt pipeline:
 *
 * SC-17  Byte-level image hashing prevents identical uploaded receipt bytes
 *        from funding two bookings.
 * SC-18  Per-identity rate limiting and a failure circuit breaker constrain
 *        automated OCR attempts.
 * ==========================================================================
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

module.exports = {
  computeImageHash,
  checkRateLimit,
  isAutomationLocked,
  recordSuccess,
  recordFailure,
  RATE_WINDOW_MS,
  MAX_SCANS_PER_WINDOW,
  FAILURE_LOCK_THRESHOLD,
};