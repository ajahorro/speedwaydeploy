import { logger } from '../utils/logger';

/**
 * scheduleValidationService.js
 * ============================================================================
 * Batch 6 / Step 6.3 — client wrapper around the server-side schedule rules.
 *
 * The authoritative decision is made by the backend
 * (POST /api/bookings/validate-slot), which shares the SAME pure rules module
 * as the browser calendar. This service never re-implements the rules — it only
 * calls the endpoint and normalises the response so the UI can render a guided
 * <ValidationModal>.
 */

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || window.location.origin;

/**
 * Asks the server whether a booking request is allowed.
 *
 * @param {object} payload
 * @param {string} payload.date - 'YYYY-MM-DD'
 * @param {string} payload.time - 'HH:MM' (or display time)
 * @param {number} [payload.durationMinutes]
 * @param {number} [payload.requestedBays]
 * @param {string} [payload.excludeBookingId] - for reschedules
 * @returns {Promise<{valid:boolean, code:string, message:string|null, details:object, reachable:boolean}>}
 *   `reachable:false` means the backend could not be contacted — callers should
 *   decide whether to fail-open (proceed) or block. We surface it explicitly
 *   rather than pretending the slot is valid.
 */
export const validateSlot = async (payload) => {
  // 🔧 FAIL-SOFT HARDENING — the endpoint is the authoritative gate, but a
  // TRANSPORT failure must not make booking impossible. `Failed to fetch` is a
  // network-layer error (backend not running, wrong host, IPv6/IPv4 mismatch,
  // stale Vite env), NOT a business-rule rejection. Previously any such error
  // returned `valid:false` + `VALIDATION_UNAVAILABLE`, which HARD-BLOCKED submit
  // with no recourse — a correct cart could never be booked while the backend
  // was down or misconfigured.
  //
  // We now: (1) retry once after a short delay to ride out a transient blip,
  // then (2) surface `reachable:false` so the caller can decide. The SERVER
  // still re-validates authoritatively inside create_booking_atomic (the DB
  // capacity trigger), so falling through here cannot double-book a slot.
  const ATTEMPT_TIMEOUT_MS = 8000;

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const response = await fetch(`${BACKEND_URL}/api/bookings/validate-slot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      // 400/409 carry a structured decision body; 200 means valid.
      const data = await response.json().catch(() => ({}));

      if (response.status === 200 && data.valid) {
        return { valid: true, code: 'OK', message: null, details: data.details || {}, reachable: true };
      }

      // Server told us it is invalid (or returned an unexpected status with a body).
      return {
        valid: false,
        code: data.code || 'SLOT_UNAVAILABLE',
        message: data.message || data.error || null,
        details: data.details || {},
        reachable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt();
  } catch (firstErr) {
    // One retry — a cold backend or a dropped keep-alive connection is common.
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return await attempt();
    } catch (err) {
      // Still unreachable. Report it honestly instead of pretending the slot is
      // invalid; the caller applies the fallback policy.
      logger.warn('Schedule validation endpoint unreachable after retry (fail-soft).', err);
      return {
        valid: false,
        code: 'VALIDATION_UNAVAILABLE',
        message: 'We could not reach the scheduling service. Please start the backend (npm run dev in /backend) and try again.',
        details: { backendUrl: BACKEND_URL, transportError: String(err?.message || err) },
        reachable: false,
      };
    }
  }
};

export default { validateSlot };
