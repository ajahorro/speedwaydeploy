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

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

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
  try {
    const response = await fetch(`${BACKEND_URL}/api/bookings/validate-slot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
  } catch (err) {
    // Network / backend-down. FAIL CLOSED: treat an unreachable validation
    // service as "not validated" so an invalid booking can never slip through
    // while the backend is offline. The code lets the UI show a retry message.
    logger.warn('Schedule validation endpoint unreachable; blocking submission (fail-closed).', err);
    return {
      valid: false,
      code: 'VALIDATION_UNAVAILABLE',
      message: 'We could not confirm this slot right now. Please try again in a moment.',
      details: {},
      reachable: false,
    };
  }
};

export default { validateSlot };
