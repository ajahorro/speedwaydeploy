/**
 * EMAIL AUTH POLICY — machine-readable source of truth.
 * See ./../docs/EMAIL_AUTH_POLICY.md for the rationale and the full rule set.
 *
 * Every auth email must declare its DELIVERY mechanism. The goal is that the
 * UI copy ("link" vs "code") and the delivered artifact can never disagree
 * again — the bug that sent an OTP from the "Send Recovery Link" button.
 */

const DELIVERY = Object.freeze({
  LINK: 'LINK', // one-time URL, Resend relay, token hashed in password_confirmation_requests
  OTP: 'OTP',   // 6-digit numeric code, in-app modal
});

/**
 * The authoritative per-flow delivery map. Add a row here BEFORE building a
 * new auth email so the mechanism is decided deliberately, not by accident.
 */
const FLOW_DELIVERY = Object.freeze({
  // ── LINK flows (unauthenticated or multi-step, high value) ──────────────
  FORGOT_PASSWORD: { delivery: DELIVERY.LINK, endpoint: '/api/auth/recover-password' },
  CHANGE_PASSWORD: { delivery: DELIVERY.LINK, endpoint: '/api/auth/request-password-change' },
  RESEND_PASSWORD_CONFIRMATION: { delivery: DELIVERY.LINK, endpoint: '/api/auth/resend-password-confirmation' },
  CHANGE_EMAIL: { delivery: DELIVERY.LINK, endpoint: '/api/auth/request-email-change' },

  // ── OTP flows (already authenticated / same-session step-up) ────────────
  EMERGENCY_RECOVERY: { delivery: DELIVERY.OTP, endpoint: '/api/auth/emergency-recovery' },
  QR_RECIPIENT_CHANGE: { delivery: DELIVERY.OTP, endpoint: '/api/admin/...' },
});

/**
 * Human-facing copy fragments. UI and email MUST pull the noun from here so a
 * "link" flow can never render the word "code" (and vice versa).
 */
const MECHANISM_COPY = Object.freeze({
  [DELIVERY.LINK]: { noun: 'link', verbPhrase: 'password reset link' },
  [DELIVERY.OTP]: { noun: 'code', verbPhrase: 'verification code' },
});

/** The delivery mechanism for a named flow (throws on an unknown flow). */
const deliveryFor = (flow) => {
  const entry = FLOW_DELIVERY[flow];
  if (!entry) throw new Error(`Unknown auth email flow: ${flow}. Add it to FLOW_DELIVERY.`);
  return entry.delivery;
};

/**
 * Guard: assert a flow's mechanism matches what the caller intends to send.
 * Call this at the top of any new auth-email route as a cheap invariant check.
 */
const assertDelivery = (flow, expected) => {
  const actual = deliveryFor(flow);
  if (actual !== expected) {
    throw new Error(`Email policy violation: flow ${flow} is ${actual} but caller expected ${expected}.`);
  }
  return true;
};

module.exports = { DELIVERY, FLOW_DELIVERY, MECHANISM_COPY, deliveryFor, assertDelivery };
