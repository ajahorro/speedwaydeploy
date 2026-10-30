import React, { useEffect, useState } from 'react';
import { subscribeBackendStatus } from '../lib/backendHealth';

/**
 * ColdStartBanner
 * ─────────────────────────────────────────────────────────────────────────────
 * A non-blocking, self-dismissing status banner that appears when the backend
 * is cold-starting (Render free tier spins down after ~15 min of inactivity).
 *
 * • Shows ONLY when backendHealth reports 'waking' — never on page transitions
 *   or normal navigation where the server is already up.
 * • Auto-dismisses 2 s after the server comes online.
 * • Does NOT block any UI — the form behind it remains interactive so a fast
 *   typist is never held up.
 * • Communicates progress via an animated pulse dot + descriptive copy so the
 *   user understands why they are waiting instead of thinking the app is broken.
 */
const ColdStartBanner = () => {
  const [status, setStatus] = useState('unknown');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unsub = subscribeBackendStatus((s) => {
      setStatus(s);
      if (s === 'waking') {
        setVisible(true);
      } else if (s === 'online' || s === 'offline') {
        // Keep banner visible briefly so the user sees the resolution.
        const timer = setTimeout(() => setVisible(false), 2000);
        return () => clearTimeout(timer);
      }
    });
    return unsub;
  }, []);

  if (!visible) return null;

  const isOffline = status === 'offline';
  const isOnline = status === 'online';

  const bannerStyle = {
    position: 'fixed',
    bottom: '1.25rem',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem 1.25rem',
    borderRadius: '8px',
    background: isOnline
      ? 'rgba(16, 185, 129, 0.95)'
      : isOffline
        ? 'rgba(239, 68, 68, 0.95)'
        : 'rgba(20, 20, 24, 0.96)',
    border: `1px solid ${isOnline ? 'rgba(16,185,129,0.4)' : isOffline ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.08)'}`,
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    backdropFilter: 'blur(12px)',
    color: '#fff',
    fontSize: '0.8rem',
    fontWeight: '700',
    letterSpacing: '0.5px',
    whiteSpace: 'nowrap',
    animation: 'coldStartSlideUp 0.35s cubic-bezier(0.16,1,0.3,1)',
    maxWidth: 'calc(100vw - 2rem)',
  };

  const dotStyle = {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: isOnline ? '#fff' : isOffline ? '#fff' : 'var(--admin-brand, #a91b18)',
    flexShrink: 0,
    animation: (!isOnline && !isOffline) ? 'coldStartPulse 1.2s ease-in-out infinite' : 'none',
  };

  const message = isOnline
    ? '✓ Server is ready'
    : isOffline
      ? '⚠ Server unreachable — check your connection'
      : '⏳ Server waking up… this takes ~30 seconds on first visit';

  return (
    <>
      <div style={bannerStyle} role="status" aria-live="polite">
        <div style={dotStyle} />
        <span>{message}</span>
      </div>
      <style>{`
        @keyframes coldStartSlideUp {
          from { opacity: 0; transform: translateX(-50%) translateY(12px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes coldStartPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.4; transform: scale(0.7); }
        }
      `}</style>
    </>
  );
};

export default ColdStartBanner;

