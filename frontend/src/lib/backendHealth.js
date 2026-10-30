/**
 * backendHealth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight backend liveness probe with exponential back-off retry.
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend runs on Render's free tier, which spins the server down after
 * ~15 minutes of inactivity. A cold start takes 30–60 seconds. During that
 * window every fetch() against BACKEND_URL either:
 *   a) hangs until the browser's default 60 s timeout fires, or
 *   b) immediately fails with "Failed to fetch" (net::ERR_CONNECTION_REFUSED)
 *
 * Neither gives the user any indication of what is happening — the UI just
 * looks frozen. This module:
 *   1. Probes GET /api/health with a short timeout (4 s per attempt).
 *   2. Retries up to MAX_ATTEMPTS times with exponential back-off + jitter.
 *   3. Notifies subscribed React components so they can show a friendly
 *      "Server waking up…" banner instead of a frozen form.
 *   4. Resolves (not rejects) once the server responds, or after all retries
 *      are exhausted — callers never need to catch here.
 *
 * The probe is shared (singleton promise per invocation window) so multiple
 * components mounting at the same time do not fan out into parallel probes.
 */

import { BACKEND_URL } from '../config/api';

const PROBE_PATH = '/api/health';
const PROBE_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 12;          // up to ~60 s of total wait time
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 8000;

/** Simple pub-sub so multiple components share one probe without polling. */
const listeners = new Set();
let currentStatus = 'unknown';   // 'unknown' | 'waking' | 'online' | 'offline'
let activeProbePromise = null;

const notify = (status) => {
  currentStatus = status;
  listeners.forEach((fn) => {
    try { fn(status); } catch { /* a listener must not break the others */ }
  });
};

/** Subscribe to status changes. Returns an unsubscribe function. */
export const subscribeBackendStatus = (listener) => {
  listeners.add(listener);
  // Deliver the current status immediately so a late subscriber is in sync.
  listener(currentStatus);
  return () => listeners.delete(listener);
};

/** Current status without subscribing. */
export const getBackendStatus = () => currentStatus;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jitter = (base) => base + Math.random() * (base * 0.3);

/**
 * Fire one probe attempt with an AbortController timeout.
 * Returns true if the server responded (any HTTP status), false on network error.
 */
const probe = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(`${BACKEND_URL}${PROBE_PATH}`, {
      method: 'GET',
      signal: controller.signal,
      // No credentials or auth needed — this is just a liveness check.
      cache: 'no-store',
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Ensure the backend is reachable, retrying with back-off.
 *
 * Returns a promise that resolves to 'online' or 'offline'.
 * Multiple simultaneous callers share the same in-flight probe.
 */
export const ensureBackendOnline = () => {
  if (activeProbePromise) return activeProbePromise;

  activeProbePromise = (async () => {
    // Fast path: if the first probe succeeds immediately (server was already
    // warm), we never show the waking banner at all.
    const firstTry = await probe();
    if (firstTry) {
      notify('online');
      activeProbePromise = null;
      return 'online';
    }

    // Server did not answer — it is either cold-starting or truly down.
    notify('waking');

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const delay = Math.min(jitter(BASE_DELAY_MS * Math.pow(1.4, attempt - 1)), MAX_DELAY_MS);
      await sleep(delay);

      const ok = await probe();
      if (ok) {
        notify('online');
        activeProbePromise = null;
        return 'online';
      }
    }

    notify('offline');
    activeProbePromise = null;
    return 'offline';
  })();

  return activeProbePromise;
};

/**
 * Reset the probe so the next call to ensureBackendOnline() re-probes from
 * scratch. Call this after a successful authenticated request confirms the
 * server is actually responding.
 */
export const resetBackendStatus = () => {
  if (currentStatus !== 'online') {
    notify('online');
  }
  activeProbePromise = null;
};

