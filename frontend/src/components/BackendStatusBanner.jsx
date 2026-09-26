import React, { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';

/**
 * <BackendStatusBanner>
 * ============================================================================
 * Proactive "scheduling backend is offline" banner.
 *
 * WHY THIS EXISTS
 * ---------------
 * The booking flow is FAIL-CLOSED: if POST /api/bookings/validate-slot cannot
 * be reached, the booking is blocked rather than risk an invalid one. That is
 * correct, but previously the ONLY signal was a console `net::ERR_CONNECTION_
 * REFUSED` plus a generic modal AFTER the user had filled in the whole wizard —
 * which reads like a mysterious app error.
 *
 * This component polls GET /api/health on an interval (and immediately on mount)
 * and, when the backend is unreachable, shows a clear, dismissible banner telling
 * the user what is wrong and that booking submission will be blocked until the
 * server is back. It self-heals: as soon as a poll succeeds the banner disappears.
 *
 * Design:
 *   - Fixed to the top, above the app chrome, z-index just under modals.
 *   - Non-blocking visually (the app stays usable for browsing) but explicit
 *     that booking submission will fail.
 *   - Tiny footprint: a HEAD/GET every ~15s while healthy, every ~8s while down
 *     (faster recovery detection without hammering a dead port).
 */

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || window.location.origin;
const HEALTHY_POLL_MS = 15000;
const DOWN_POLL_MS = 8000;
const FETCH_TIMEOUT_MS = 4000;

const BackendStatusBanner = () => {
  const [offline, setOffline] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(false);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${BACKEND_URL}/api/health`, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });
      // Any HTTP response means the process is up and answering.
      setOffline(!res.ok && res.status >= 500);
    } catch {
      setOffline(true);
    } finally {
      clearTimeout(timer);
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timerId;

    const loop = async () => {
      if (cancelled) return;
      await checkHealth();
      if (cancelled) return;
      timerId = setTimeout(loop, offline ? DOWN_POLL_MS : HEALTHY_POLL_MS);
    };

    loop();
    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [checkHealth, offline]);

  // Reset the "dismissed" flag whenever connectivity flips back to offline, so a
  // NEW outage always re-alerts even if the user dismissed the previous one.
  useEffect(() => {
    if (offline) setDismissed(false);
  }, [offline]);

  if (!offline || dismissed) return null;

  return (
    <div
      role="alert"
      className="backend-status-banner"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 999998,
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.7rem 1rem',
        background: 'var(--status-warning, #f59e0b)',
        color: '#1a1200',
        fontWeight: 800,
        fontSize: '0.82rem',
        lineHeight: 1.4,
        boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
      }}
    >
      <AlertTriangle size={18} style={{ flexShrink: 0 }} aria-hidden="true" />
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong>Booking server is offline.</strong>{' '}
        {`The scheduling service at ${BACKEND_URL} is not responding. You can still browse,
        but new bookings cannot be submitted until it is back online.`}
      </span>

      <button
        type="button"
        onClick={checkHealth}
        disabled={checking}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
          background: 'rgba(0,0,0,0.15)', color: '#1a1200',
          border: '1px solid rgba(0,0,0,0.25)', borderRadius: '6px',
          padding: '0.35rem 0.7rem', fontWeight: 900, fontSize: '0.72rem',
          textTransform: 'uppercase', letterSpacing: '0.5px',
          cursor: checking ? 'wait' : 'pointer', flexShrink: 0,
        }}
      >
        <RefreshCw size={14} className={checking ? 'spin' : undefined} />
        {checking ? 'Checking' : 'Retry'}
      </button>

      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        style={{
          background: 'none', border: 'none', color: '#1a1200',
          cursor: 'pointer', lineHeight: 0, padding: '0.2rem', flexShrink: 0,
        }}
      >
        <X size={18} />
      </button>

      <style>{`
        @keyframes backend-banner-spin { to { transform: rotate(360deg); } }
        .backend-status-banner .spin { animation: backend-banner-spin 0.9s linear infinite; }
      `}</style>
    </div>
  );
};

export default BackendStatusBanner;