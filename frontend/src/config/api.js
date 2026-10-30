/**
 * ONE place that resolves the backend origin for every browser call.
 *
 * WHY THIS EXISTS
 * ---------------
 * `import.meta.env.VITE_BACKEND_URL || window.location.origin` was duplicated
 * across the app. Vite inlines VITE_* at BUILD time, so a deployed build that was
 * configured with `VITE_BACKEND_URL=http://localhost:3000` (the value in the
 * checked-in frontend/.env) ships EVERY visitor a bundle that calls their OWN
 * machine on port 3000. Nothing listens there, so:
 *
 *   - "Rotate Security Key" reports "Identity verification failed" (verifyPassword
 *     swallows the connection error and returns { success: false }).
 *   - "Send Invite" fails with an opaque toast.
 *   - Service deletion silently archives instead of checking usage.
 *
 * and the network tab shows a bare `net::ERR_CONNECTION_REFUSED` against
 * localhost — which reads as "nothing in the console for errors".
 *
 * RESOLUTION ORDER
 *   1. window.__APP_CONFIG__.backendUrl     (runtime override, no rebuild needed)
 *   2. VITE_BACKEND_URL                     (build-time, only when usable)
 *   3. window.location.origin               (same-origin / reverse-proxy deploy)
 *
 * A localhost VITE_BACKEND_URL is only honoured when the page ITSELF is served
 * from localhost. On a deployed site it is treated as "not configured" so calls
 * go somewhere real, and the mistake is logged loudly instead of failing silently.
 */

/** True when `value` points at the machine the browser is running on. */
const isLoopback = (value) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(value || ''));

/** True when the current page is itself served from loopback. */
const pageIsLoopback = () =>
  typeof window !== 'undefined'
  && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);

const resolveBackendUrl = () => {
  // 1. Runtime override — lets a deploy be corrected without a rebuild.
  const runtime = typeof window !== 'undefined' ? window.__APP_CONFIG__?.backendUrl : null;
  if (runtime) return String(runtime).replace(/\/+$/, '');

  // 2. Build-time value, but only when it can actually work from this page.
  const configured = import.meta.env?.VITE_BACKEND_URL;
  if (configured) {
    const value = String(configured).replace(/\/+$/, '');
    if (!isLoopback(value) || pageIsLoopback()) return value;

    // Configured for a dev backend while running on a deployed site: the single
    // most likely cause of "the API just does nothing". Say so, loudly, once.
    console.error(
      `[api] VITE_BACKEND_URL is "${value}" but this page is served from `
      + `"${window.location.hostname}". Every /api call would fail with a connection `
      + 'refused. Set VITE_BACKEND_URL in the deploy environment (or window.__APP_CONFIG__.backendUrl) '
      + 'to the public backend origin, then rebuild.'
    );
  }

  // 3. Same-origin (a reverse proxy that also serves /api).
  return typeof window !== 'undefined' ? window.location.origin : '';
};

export const BACKEND_URL = resolveBackendUrl();

/**
 * Headers for an authenticated backend call. The backend derives the actor from
 * this bearer token — never from a userId in the request body.
 */
export const authHeaders = async (extra = {}) => {
  // Lazy on purpose: lib/supabase eagerly loads every service module, and those
  // import this file, so a static import here would create a load-order cycle.
  const { supabase } = await import('../lib/supabase');
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    ...extra
  };
};

/**
 * Standardized Centralized API Fetch Helper
 *
 * Cold-start retry: on Render free tier the backend takes 30-60 s to wake
 * up after inactivity. A cold fetch() returns a network error immediately
 * (ERR_CONNECTION_REFUSED), not a timeout, so the user gets an error before
 * the server is ready. On a network-level failure we trigger
 * ensureBackendOnline(), which probes /api/health with back-off until the
 * server responds, then retries the original request once.
 *
 *   Warm server  : zero overhead (first attempt succeeds instantly).
 *   Cold server  : ColdStartBanner shown for ~30 s, then auto-retried.
 *   Offline      : fails after back-off, surfaces original error.
 */
export const apiFetch = async (endpoint, options = {}) => {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = endpoint.startsWith('http') ? endpoint : `${BACKEND_URL}${cleanEndpoint}`;

  const doFetch = async () => {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || errorData.message || `HTTP error! status: ${response.status}`);
    }
    return response.json();
  };

  try {
    const result = await doFetch();
    // A successful call means the server is up — keep status in sync.
    import('../lib/backendHealth').then(({ resetBackendStatus }) => resetBackendStatus()).catch(() => {});
    return result;
  } catch (err) {
    // Only retry on a raw network error (TypeError), not on 4xx / 5xx.
    const isNetworkError = err instanceof TypeError && /fetch|network|failed/i.test(err.message);
    if (!isNetworkError) throw err;

    // Wait for the server to wake, then retry once.
    const { ensureBackendOnline } = await import('../lib/backendHealth');
    const serverStatus = await ensureBackendOnline();
    if (serverStatus !== 'online') throw err; // never came up, surface original
    return doFetch();
  }
};
