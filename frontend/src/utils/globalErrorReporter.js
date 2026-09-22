import toast from 'react-hot-toast';
import { logger } from './logger';

/**
 * globalErrorReporter.js
 * ============================================================================
 * Batch 7 / Step 7.1 — Offline / unhandled-error safety net.
 *
 * Installs two document/window-level listeners that would otherwise let an error
 * vanish into the console:
 *
 *   - `unhandledrejection` : a promise rejected with no `.catch()` (e.g. a
 *     background fetch, a fire-and-forget RPC).
 *   - `error` (window.onerror): a synchronous throw outside React's render path
 *     (event handlers, timers, third-party callbacks).
 *
 * Both are:
 *   1. Logged with full detail for diagnostics.
 *   2. Surfaced to the user as a single, non-spammy toast.
 *
 * Deduplication: identical messages within a short window collapse into one
 * toast, so a retry loop cannot carpet the screen with identical errors.
 *
 * Returns an unsubscribe function so the caller can clean up in tests/HMR.
 */

const DEDUPE_WINDOW_MS = 5000;
const recent = new Map(); // message -> timestamp of last shown toast

// Errors we deliberately ignore: benign noise that is not actionable for the
// user and would otherwise generate a misleading toast.
const IGNORED_PATTERNS = [
  /ResizeObserver loop/i,
  /Non-Error promise rejection captured/i,
  /Loading chunk \d+ failed/i, // handled by the reload affordance, not a toast
];

const isIgnored = (message) => IGNORED_PATTERNS.some((re) => re.test(message));

const shouldShow = (message) => {
  const now = Date.now();
  // Opportunistically evict stale entries so the map cannot grow unbounded.
  for (const [key, ts] of recent) {
    if (now - ts > DEDUPE_WINDOW_MS) recent.delete(key);
  }
  const last = recent.get(message);
  if (last && now - last < DEDUPE_WINDOW_MS) return false;
  recent.set(message, now);
  return true;
};

// Turns any thrown value into a short, user-facing sentence.
const toUserMessage = (value) => {
  const raw = value && value.message ? String(value.message) : String(value || '');
  const trimmed = raw.trim();
  if (!trimmed) return 'Something went wrong. Please try again.';
  // Avoid dumping stack traces / internals into the UI.
  const firstLine = trimmed.split('\n')[0];
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
};

const report = (source, value) => {
  const message = toUserMessage(value);
  logger.error(`[global-error:${source}]`, value);

  if (isIgnored(message)) return;
  if (!shouldShow(message)) return;

  // react-hot-toast is a no-op if no <Toaster/> is mounted, so this is safe
  // even before the app tree renders (e.g. an error during boot).
  toast.error(message, { id: `global-${source}-${message}` });
};

/**
 * Installs the global handlers. Idempotent: installing twice is a no-op.
 * @returns {() => void} uninstall function
 */
export const installGlobalErrorReporter = () => {
  if (typeof window === 'undefined') return () => { };

  // Guard against double-install (React StrictMode double-invokes effects).
  if (window.__speedwayErrorReporterInstalled) return () => { };
  window.__speedwayErrorReporterInstalled = true;

  const onRejection = (event) => {
    // `event.reason` is often an Error; sometimes a string.
    report('unhandledrejection', event?.reason);
  };

  const onError = (event) => {
    // Ignore resource-loading errors (e.g. a missing image) — those have no
    // message and are not actionable as a toast.
    if (event && !event.message && event.target && event.target !== window) return;
    report('window.onerror', event?.error || event?.message);
  };

  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('error', onError);

  // Expose a bridge so class-based boundaries (ErrorBoundary) can reuse the
  // same reporting/dedupe path instead of re-implementing it.
  window.__speedwayReportError = (error) => report('boundary', error);

  return () => {
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('error', onError);
    window.__speedwayErrorReporterInstalled = false;
    delete window.__speedwayReportError;
  };
};

export default installGlobalErrorReporter;