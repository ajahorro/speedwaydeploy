import React, { useEffect, useState } from 'react';
import { subscribeBackendStatus } from '../lib/backendHealth';

/**
 * ColdStartBanner
 * ─────────────────────────────────────────────────────────────────────────────
 * A small, non-blocking note shown while something the user did is waiting on the backend
 * (Render's free tier puts it to sleep after ~15 idle minutes and it takes a while to wake).
 *
 * • Only reacts to 'waking', which apiFetch reports when a real request could not reach the server.
 *   Page loads never trigger it (main.jsx only sends a silent warm-up request).
 * • Stays hidden for the first SHOW_AFTER_MS, so short waits never flash a message.
 * • Plain wording that talks about the user's action, not about servers.
 * • Closes on its own: right away if the wait ended before it appeared, shortly after otherwise.
 */
const SHOW_AFTER_MS = 4000;
const HIDE_AFTER_READY_MS = 1500;
const HIDE_AFTER_FAIL_MS = 6000;

const ColdStartBanner = () => {
  const [status, setStatus] = useState('unknown');
  const [visible, setVisible] = useState(false);

  useEffect(() => subscribeBackendStatus(setStatus), []);

  useEffect(() => {
    if (status === 'waking') {
      const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
      return () => clearTimeout(timer);
    }
    if (!visible) return undefined;
    const timer = setTimeout(() => setVisible(false), status === 'offline' ? HIDE_AFTER_FAIL_MS : HIDE_AFTER_READY_MS);
    return () => clearTimeout(timer);
  }, [status, visible]);

  if (!visible) return null;

  const isOffline = status === 'offline';
  const isOnline = status === 'online';

  const message = isOnline
    ? 'All set.'
    : isOffline
      ? 'We couldn’t connect. Please check your internet and try again.'
      : 'Just a moment, getting this ready for you…';

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed',
          bottom: '1.25rem',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          gap: '0.65rem',
          padding: '0.7rem 1.1rem',
          borderRadius: '10px',
          background: isOffline ? 'rgba(127, 29, 29, 0.96)' : 'rgba(20, 20, 24, 0.96)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
          backdropFilter: 'blur(12px)',
          color: '#fff',
          fontSize: '0.82rem',
          fontWeight: 600,
          lineHeight: 1.4,
          maxWidth: 'calc(100vw - 2rem)',
          animation: 'coldStartSlideUp 0.3s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {!isOnline && !isOffline && <span className="cold-start-spinner" aria-hidden="true" />}
        <span>{message}</span>
      </div>
      <style>{`
        @keyframes coldStartSlideUp {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes coldStartSpin { to { transform: rotate(360deg); } }
        .cold-start-spinner {
          width: 14px; height: 14px; flex-shrink: 0; border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.25); border-top-color: #fff;
          animation: coldStartSpin 0.8s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) { .cold-start-spinner { animation-duration: 2.4s; } }
      `}</style>
    </>
  );
};

export default ColdStartBanner;
