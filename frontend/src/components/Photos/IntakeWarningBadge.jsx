import React from 'react';
import { AlertTriangle, CheckCircle, Camera } from 'lucide-react';

/**
 * IntakeWarningBadge — Batch 5
 *
 * Compact, reusable status chip for the pre-service ("before") photo state.
 * Used by staff task cards, admin booking detail, and the completion flow.
 *
 * tone="warning"  missing intake photo (soft warning — non-blocking)
 * tone="ok"       intake photo present
 * tone="danger"   completion photo missing (blocking)
 *
 * Tokens only (var(...)); dark/light adaptive.
 */
const TONE = {
  warning: { color: 'var(--status-warning)', icon: AlertTriangle },
  danger: { color: 'var(--status-danger)', icon: AlertTriangle },
  ok: { color: 'var(--status-success)', icon: CheckCircle }
};

const IntakeWarningBadge = ({ tone = 'warning', children, compact = false }) => {
  const { color, icon: Icon } = TONE[tone] || TONE.warning;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        fontSize: compact ? '0.6rem' : '0.66rem',
        fontWeight: 900,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color,
        border: `1px solid ${color}`,
        background: 'transparent',
        borderRadius: 'var(--admin-radius-sm)',
        padding: compact ? '0.15rem 0.4rem' : '0.25rem 0.55rem',
        whiteSpace: 'nowrap'
      }}
    >
      {Icon ? <Icon size={compact ? 10 : 12} /> : <Camera size={12} />}
      {children}
    </span>
  );
};

export default IntakeWarningBadge;
