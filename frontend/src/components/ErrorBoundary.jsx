import React from 'react';
import { RotateCw, AlertTriangle, Home } from 'lucide-react';
import { logger } from '../utils/logger';

/**
 * ErrorBoundary
 * ============================================================================
 * Batch 7 / Step 7.1 — Global render-error safety net.
 *
 * A class-based boundary that catches any error thrown while rendering the tree
 * below it and shows a friendly, token-styled fallback instead of a blank white
 * screen. It sits ABOVE the theme provider in the tree, so it must not rely on
 * React context — it styles itself with native CSS tokens (`var(--admin-*)`),
 * which resolve correctly from `document.documentElement[data-theme]` whether or
 * not the theme provider mounted.
 *
 * Two recovery actions:
 *   - "Reload App"   — full reload (recovers from a wedged client state).
 *   - "Try Again"    — reset the boundary and re-render (recovers from a
 *                      transient/one-off error without losing the session).
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Log with full component stack so the failure is diagnosable in prod.
    logger.error('Unhandled render error caught by ErrorBoundary', error, info?.componentStack);

    // Best-effort: surface it to any app-level toast hook the host installed.
    try {
      if (typeof window !== 'undefined' && typeof window.__speedwayReportError === 'function') {
        window.__speedwayReportError(error);
      }
    } catch { /* never let reporting mask the original error */ }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    // In development, surface the message to speed up debugging; in production
    // show only the friendly copy so we never leak internals to users.
    const detail = import.meta.env.DEV && this.state.error
      ? String(this.state.error.message || this.state.error)
      : null;

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'clamp(1rem, 5vw, 2rem)',
          background: 'var(--admin-bg, #0A0B0D)',
          color: 'var(--admin-text-primary, #FFFFFF)',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '460px',
            background: 'var(--admin-card, #15171A)',
            border: '1px solid var(--admin-border, rgba(255,255,255,0.08))',
            borderRadius: 'var(--admin-radius, 8px)',
            boxShadow: 'var(--admin-card-shadow, 0 10px 30px rgba(0,0,0,0.5))',
            padding: 'clamp(1.5rem, 6vw, 2.5rem)',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: '56px',
              height: '56px',
              margin: '0 auto 1.25rem',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(var(--admin-brand-rgb, 230,30,42), 0.12)',
            }}
          >
            <AlertTriangle size={28} color="var(--admin-brand, #E61E2A)" aria-hidden="true" />
          </div>

          <h1
            style={{
              margin: 0,
              fontSize: '1.25rem',
              fontWeight: 950,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--admin-text-primary, #FFFFFF)',
            }}
          >
            Something went wrong
          </h1>

          <p
            style={{
              margin: '0.75rem 0 0',
              fontSize: '0.9rem',
              fontWeight: 600,
              lineHeight: 1.6,
              color: 'var(--admin-text-secondary, #8E9196)',
            }}
          >
            An unexpected error interrupted this screen. Your data is safe — reload
            to continue, or try again.
          </p>

          {detail && (
            <pre
              style={{
                margin: '1.25rem 0 0',
                padding: '0.75rem 1rem',
                textAlign: 'left',
                fontSize: '0.72rem',
                fontWeight: 600,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '140px',
                overflowY: 'auto',
                borderRadius: 'var(--admin-radius-sm, 4px)',
                background: 'var(--admin-bg, #0A0B0D)',
                border: '1px solid var(--admin-border, rgba(255,255,255,0.08))',
                color: 'var(--status-danger, #ef4444)',
              }}
            >
              {detail}
            </pre>
          )}

          <div
            className="error-boundary-actions"
            style={{
              marginTop: '1.75rem',
              display: 'flex',
              gap: '0.75rem',
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                flex: '1 1 150px',
                minHeight: '2.75rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                padding: '0.85rem 1.25rem',
                borderRadius: 'var(--admin-radius-sm, 4px)',
                background: 'var(--admin-brand, #E61E2A)',
                color: 'var(--admin-text-on-brand)',
                border: '1px solid var(--admin-brand, #E61E2A)',
                fontSize: '0.8rem',
                fontWeight: 950,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                cursor: 'pointer',
              }}
            >
              <RotateCw size={15} /> Reload App
            </button>

            <button
              type="button"
              onClick={this.handleReset}
              style={{
                flex: '1 1 150px',
                minHeight: '2.75rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                padding: '0.85rem 1.25rem',
                borderRadius: 'var(--admin-radius-sm, 4px)',
                background: 'var(--admin-bg, #0A0B0D)',
                color: 'var(--admin-text-primary, #FFFFFF)',
                border: '1px solid var(--admin-border, rgba(255,255,255,0.08))',
                fontSize: '0.8rem',
                fontWeight: 950,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
          </div>

          <button
            type="button"
            onClick={() => { if (typeof window !== 'undefined') window.location.assign('/'); }}
            style={{
              marginTop: '1rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              background: 'transparent',
              border: 'none',
              color: 'var(--admin-text-secondary, #8E9196)',
              fontSize: '0.72rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <Home size={13} /> Back to home
          </button>
        </div>

        <style>{`
          @media (max-width: 420px) {
            .error-boundary-actions { flex-direction: column; }
            .error-boundary-actions button { flex: 1 1 auto !important; width: 100%; }
          }
        `}</style>
      </div>
    );
  }
}

export default ErrorBoundary;