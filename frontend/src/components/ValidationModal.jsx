import React from 'react';
import {
  X, CalendarX2, CalendarOff, Ban, CalendarClock, Timer, Clock3, Users, AlertTriangle,
} from 'lucide-react';

/**
 * <ValidationModal>
 * ============================================================================
 * Batch 6 / Step 6.3 — Guided schedule-restriction feedback.
 *
 * A reusable modal that turns a structured schedule-validation failure (from
 * POST /api/bookings/validate-slot) into a clear, friendly, actionable message.
 *
 * It is deliberately presentational + dumb: the parent decides what the actions
 * do. Two actions are supported and both are optional:
 *   - onPickAnotherTime()      "Pick Another Time"          (primary)
 *   - onSelectNextAvailable()  "Select Next Available Date" (secondary)
 *
 * Error codes it understands (mirrors the backend vocabulary):
 *   PAST_DATE, CLOSED_WEEKDAY, BLOCKED_DATE, BEYOND_ADVANCE_WINDOW,
 *   LEAD_TIME, SLOT_UNAVAILABLE, CAPACITY_EXCEEDED
 * Unknown codes fall back to a generic-but-safe presentation, so a future
 * backend code can never render an empty modal.
 *
 * Styling: native project CSS tokens only (var(--admin-*)), full dark/light
 * support, and a 375px-safe single-column layout.
 */

// Per-code presentation: icon, tinted accent, title, and next-step guidance.
const CODE_PRESENTATION = {
  PAST_DATE: {
    icon: CalendarX2,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Invalid date',
    title: 'That date has passed',
    guidance: 'Please choose today or a future date to continue.',
  },
  CLOSED_WEEKDAY: {
    icon: CalendarOff,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Shop closed',
    title: 'We are closed on that day',
    guidance: 'Select another day of the week when the shop is open.',
  },
  BLOCKED_DATE: {
    icon: Ban,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Date unavailable',
    title: 'This date is blocked',
    guidance: 'The shop has marked this date as unavailable. Please pick a different day.',
  },
  BEYOND_ADVANCE_WINDOW: {
    icon: CalendarClock,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Too far ahead',
    title: 'That date is too far in advance',
    guidance: 'Bookings open closer to the day. Choose an earlier date within our booking window.',
  },
  LEAD_TIME: {
    icon: Timer,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Notice too short',
    title: 'This slot is too soon',
    guidance: 'We need more notice to prepare. Please pick a later time today or another day.',
  },
  SLOT_UNAVAILABLE: {
    icon: Clock3,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Slot unavailable',
    title: 'That time is not available',
    guidance: 'The shop has reserved or blocked this slot. Please choose another time.',
  },
  CAPACITY_EXCEEDED: {
    icon: Users,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Fully booked',
    title: 'That slot is fully booked',
    guidance: 'All bays are taken for this time. Try a different time or another day.',
  },
  // Fallbacks for malformed requests / infra hiccups.
  INVALID_DATE: {
    icon: CalendarX2,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Check the date',
    title: 'We could not read that date',
    guidance: 'Please reselect a valid date and try again.',
  },
  INVALID_SLOT: {
    icon: Clock3,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Check the time',
    title: 'We could not read that time',
    guidance: 'Please reselect a valid start time and try again.',
  },
  // Backend unreachable (fail-closed). This is a transient, retryable state.
  VALIDATION_UNAVAILABLE: {
    icon: AlertTriangle,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Connection issue',
    title: 'We could not confirm this slot',
    guidance: 'Our scheduling service is temporarily unavailable. Please try submitting again in a moment.',
  },
  DEFAULT: {
    icon: AlertTriangle,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Not available',
    title: 'That slot is not available',
    guidance: 'Please pick another time or date to continue.',
  },
};

const ValidationModal = ({
  open,
  code,
  message,
  details,
  onClose,
  onPickAnotherTime,
  onSelectNextAvailable,
}) => {
  if (!open) return null;

  const presentation = CODE_PRESENTATION[code] || CODE_PRESENTATION.DEFAULT;
  const Icon = presentation.icon;
  // The server message is the specific, contextual explanation; the per-code
  // `guidance` is the generic actionable next step. They are distinct, so we
  // only show the body paragraph when the server actually sent a message —
  // otherwise the guidance line alone carries the explanation (no duplication).
  const serverMessage = typeof message === 'string' && message.trim() ? message.trim() : null;

  // Human-readable echo of what the user attempted (date/time), when known.
  const attempted = [
    details?.date,
    details?.time,
  ].filter(Boolean).join(' · ');

  // Only render an action when its handler exists — keeps the modal honest.
  const showPickTime = typeof onPickAnotherTime === 'function';
  const showNextDate = typeof onSelectNextAvailable === 'function';

  return (
    <div
      className="app-modal-backdrop validation-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="validation-modal-title"
      onClick={onClose || undefined}
      style={{
        position: 'fixed', inset: 0, zIndex: 999999,
        background: 'var(--modal-overlay)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        className="validation-modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--admin-card)',
          border: '1px solid var(--admin-border)',
          borderRadius: 'var(--admin-radius-lg, var(--admin-radius))',
          boxShadow: 'var(--modal-shadow)',
          width: '100%',
          maxWidth: '460px',
          maxHeight: '90vh',
          overflowY: 'auto',
          position: 'relative',
        }}
      >
        {/* Header band */}
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: '1rem',
            padding: '1.5rem 1.5rem 1.25rem',
            borderBottom: '1px solid var(--admin-border)',
            background: `rgba(${presentation.accentRgb}, 0.06)`,
          }}
        >
          <div
            style={{
              width: '48px', height: '48px', flexShrink: 0,
              borderRadius: 'var(--admin-radius-md, 10px)',
              background: `rgba(${presentation.accentRgb}, 0.14)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon size={24} color={presentation.accent} aria-hidden="true" />
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block', fontSize: '0.62rem', fontWeight: 950,
                color: presentation.accent, textTransform: 'uppercase',
                letterSpacing: '1px', marginBottom: '0.3rem',
              }}
            >
              {presentation.eyebrow}
            </span>
            <h3
              id="validation-modal-title"
              style={{
                margin: 0, fontSize: '1.15rem', fontWeight: 950,
                color: 'var(--admin-text-primary)', lineHeight: 1.3,
              }}
            >
              {presentation.title}
            </h3>
          </div>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: 'none', border: 'none', padding: '0.25rem',
                color: 'var(--admin-text-secondary)', cursor: 'pointer',
                flexShrink: 0, lineHeight: 0,
              }}
            >
              <X size={20} />
            </button>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '1.5rem' }}>
          <div
            style={{
              display: 'flex', gap: '0.6rem', alignItems: 'flex-start',
              fontSize: '0.92rem', fontWeight: 600,
              color: 'var(--admin-text-primary)', lineHeight: 1.6,
            }}
          >
            <span style={{ color: presentation.accent, lineHeight: 0, marginTop: '3px' }}>→</span>
            <span>{presentation.guidance}</span>
          </div>

          {/* Server explanation — only when it adds something beyond the guidance. */}
          {serverMessage && serverMessage !== presentation.guidance && (
            <p
              style={{
                margin: '0.85rem 0 0', fontSize: '0.85rem', fontWeight: 600,
                color: 'var(--admin-text-secondary)', lineHeight: 1.6,
              }}
            >
              {serverMessage}
            </p>
          )}

          {attempted && (
            <div
              style={{
                marginTop: '1rem', padding: '0.75rem 1rem',
                background: 'var(--admin-bg)',
                border: '1px solid var(--admin-border)',
                borderRadius: 'var(--admin-radius-sm)',
                fontSize: '0.72rem', fontWeight: 800,
                color: 'var(--admin-text-secondary)',
                textTransform: 'uppercase', letterSpacing: '0.5px',
              }}
            >
              Requested: <span style={{ color: 'var(--admin-text-primary)' }}>{attempted}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div
          className="validation-modal-actions"
          style={{
            display: 'flex', gap: '0.75rem', flexWrap: 'wrap',
            padding: '1.25rem 1.5rem 1.5rem',
            borderTop: '1px solid var(--admin-border)',
          }}
        >
          {showNextDate && (
            <button
              type="button"
              onClick={onSelectNextAvailable}
              style={{
                flex: '1 1 160px', minHeight: '2.75rem',
                padding: '0.85rem 1.25rem',
                background: 'var(--admin-bg)',
                color: 'var(--admin-text-primary)',
                border: '1px solid var(--admin-border)',
                borderRadius: 'var(--admin-radius-sm)',
                fontWeight: 950, fontSize: '0.78rem',
                textTransform: 'uppercase', letterSpacing: '0.5px',
                cursor: 'pointer',
              }}
            >
              Select Next Available Date
            </button>
          )}

          {showPickTime && (
            <button
              type="button"
              onClick={onPickAnotherTime}
              style={{
                flex: '1 1 160px', minHeight: '2.75rem',
                padding: '0.85rem 1.25rem',
                background: 'var(--admin-brand)',
                color: '#fff',
                border: '1px solid var(--admin-brand)',
                borderRadius: 'var(--admin-radius-sm)',
                fontWeight: 950, fontSize: '0.78rem',
                textTransform: 'uppercase', letterSpacing: '0.5px',
                cursor: 'pointer',
              }}
            >
              Pick Another Time
            </button>
          )}
        </div>
      </div>

      <style>{`
        /* 375px-safe: stack actions full-width and tighten padding. */
        @media (max-width: 420px) {
          .validation-modal-card { max-width: 100%; }
          .validation-modal-actions {
            flex-direction: column;
          }
          .validation-modal-actions button {
            flex: 1 1 auto !important;
            width: 100%;
          }
        }
      `}</style>
    </div>
  );
};

export default ValidationModal;
