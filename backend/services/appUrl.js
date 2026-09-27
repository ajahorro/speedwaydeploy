/**
 * backend/services/appUrl.js
 * ============================================================================
 * ONE place that resolves the public URL of the frontend.
 *
 * WHY THIS EXISTS
 * ---------------
 * Five call sites independently wrote:
 *
 *     `${process.env.FRONTEND_URL || 'http://localhost:5173'}/...`
 *
 * On a deployed site `FRONTEND_URL` is easy to forget in the host's environment,
 * and the fallback is SILENT — the server keeps working, the email sends
 * successfully, and the customer receives a link to `localhost:5173`, which is
 * their own machine. That is indistinguishable from "the email link is broken",
 * and it is exactly the reported symptom: confirmation links not leading where
 * they are intended.
 *
 * The fallback is therefore only allowed in development. In production a missing
 * FRONTEND_URL is a CONFIGURATION ERROR and must be loud, because every email we
 * send depends on it.
 *
 * RESOLUTION ORDER
 *   1. FRONTEND_URL                       (explicit, preferred)
 *   2. APP_URL / PUBLIC_APP_URL           (common host-provided aliases)
 *   3. VERCEL_URL                         (auto-set by Vercel; no scheme)
 *   4. localhost, ONLY when not production
 * ============================================================================
 */

const DEV_FALLBACK = 'http://localhost:5173';

/** True when `value` points at the machine the process is running on. */
const isLoopbackUrl = (value) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(String(value || '').trim());

/** True when the process believes it is running in production. */
const isProduction = () =>
  process.env.NODE_ENV === 'production'
  || Boolean(process.env.VERCEL_ENV && process.env.VERCEL_ENV === 'production')
  || Boolean(process.env.RENDER)
  || Boolean(process.env.FLY_APP_NAME);

let warnedOnce = false;

/**
 * The public base URL of the frontend, with no trailing slash.
 *
 * @returns {string}
 * @throws {Error} in production when no usable public URL is configured — failing
 *   loudly is the point: a silent localhost link is worse than a visible error.
 */
const getAppUrl = () => {
  const explicit = process.env.FRONTEND_URL
    || process.env.APP_URL
    || process.env.PUBLIC_APP_URL;

  if (explicit) {
    const value = String(explicit).replace(/\/+$/, '');

    // A leftover DEV value (e.g. FRONTEND_URL=http://localhost:5173, the value in
    // the local backend/.env) is WORSE than an unset one: it passes every presence
    // check, the email sends successfully, and the recipient receives a link to
    // their OWN machine that they can never open. In production we must refuse it
    // exactly as if it were missing, and fall through to a real host-provided URL
    // if one exists (VERCEL_URL), otherwise fail loudly.
    if (isProduction() && isLoopbackUrl(value)) {
      console.error(
        `⚠️  FRONTEND_URL is set to "${value}" in production — that is a local `
        + 'development address. Every emailed link (confirmation, password reset, '
        + 'invites, booking notifications) would point at the recipient\'s own machine '
        + 'and be unusable. Set FRONTEND_URL to the public site origin, e.g. '
        + 'https://your-domain.com'
      );
      // Fall through to VERCEL_URL / throw rather than return the loopback value.
    } else {
      return value;
    }
  }

  // Vercel sets VERCEL_URL without a scheme (e.g. my-app.vercel.app).
  if (process.env.VERCEL_URL) {
    return `https://${String(process.env.VERCEL_URL).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  }

  if (isProduction()) {
    throw new Error(
      'FRONTEND_URL is not set. Every email link (confirmation, password reset, '
      + 'booking notifications) would point at localhost and be unusable. Set '
      + 'FRONTEND_URL to the public site origin, e.g. https://your-domain.com'
    );
  }

  if (!warnedOnce) {
    warnedOnce = true;
    console.warn(
      `⚠️  FRONTEND_URL is not set — falling back to ${DEV_FALLBACK} for local development. `
      + 'Set FRONTEND_URL before deploying, or emailed links will point at localhost.'
    );
  }
  return DEV_FALLBACK;
};

/**
 * Build an absolute URL to a frontend path.
 * @param {string} path e.g. '/auth/callback'
 * @returns {string}
 */
const appUrl = (path = '/') => {
  const base = getAppUrl();
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
};

module.exports = { getAppUrl, appUrl, isProduction, isLoopbackUrl, DEV_FALLBACK };