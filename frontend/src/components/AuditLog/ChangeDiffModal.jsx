import React from 'react';
import { ArrowLeft, ArrowRight, X, GitCompare } from 'lucide-react';

/**
 * ChangeDiffModal
 * ============================================================================
 * Batch 7 / Step 7.5 — Task B: Localized Audit Log "[View Changes]" diff.
 *
 * Renders a side-by-side OLD vs NEW comparison of the fields an audit entry
 * touched. Reads the change payload from `metadata.old_values` / `metadata.
 * new_values` (the shape the Task B RPCs write). Falls back gracefully when a
 * log carries no structured diff.
 *
 * Styling: native project tokens only; 375px-safe (columns stack, no overflow).
 */

const prettyLabel = (key) =>
  String(key).replace(/^old_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const renderValue = (value) => {
  if (value === null || value === undefined || value === '') {
    return <span style={{ color: 'var(--admin-text-secondary)', fontStyle: 'italic' }}>—</span>;
  }
  return String(value);
};

const ChangeDiffModal = ({ open, log, onClose }) => {
  if (!open || !log) return null;

  const metadata = log.metadata || {};
  const oldValues = metadata.old_values || {};
  const newValues = metadata.new_values || {};

  // Union of keys across both sides, ignoring the internal old_* mirror keys.
  const keys = Array.from(new Set([
    ...Object.keys(oldValues),
    ...Object.keys(newValues),
  ])).filter((k) => !k.startsWith('old_'));

  // Some entries only carry a flat metadata diff (e.g. reschedule old/new_start).
  const flatKeys = keys.length ? keys : Object.keys(metadata).filter((k) => /^(old|new)_/.test(k)
    ? false
    : ['old_start', 'new_start', 'old_end', 'new_end', 'reason'].includes(k));

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        background: 'var(--modal-overlay)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--admin-card)', border: '1px solid var(--admin-border)',
          borderRadius: 'var(--admin-radius-lg, var(--admin-radius))',
          boxShadow: 'var(--modal-shadow)', width: '100%', maxWidth: '560px',
          maxHeight: '90vh', overflowY: 'auto', position: 'relative',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: '0.75rem',
            padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--admin-border)',
          }}
        >
          <span
            style={{
              width: '40px', height: '40px', flexShrink: 0, borderRadius: 'var(--admin-radius-sm)',
              background: 'rgba(var(--admin-brand-rgb), 0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <GitCompare size={20} color="var(--admin-brand)" aria-hidden="true" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 id="change-diff-title" style={{ margin: 0, fontSize: '1.05rem', fontWeight: 950, color: 'var(--admin-text-primary)' }}>
              View Changes
            </h3>
            <p style={{ margin: '0.15rem 0 0', fontSize: '0.72rem', fontWeight: 700, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {(log.event_type || log.action_type || '').replace(/_/g, ' ')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', padding: '0.25rem', color: 'var(--admin-text-secondary)', cursor: 'pointer', flexShrink: 0 }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '1.5rem' }}>
          {flatKeys.length === 0 ? (
            <div style={{ padding: '1.25rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: 600, textAlign: 'center' }}>
              This entry has no field-level changes recorded.
              {log.details ? <div style={{ marginTop: '0.5rem', color: 'var(--admin-text-primary)' }}>{log.details}</div> : null}
            </div>
          ) : (
            <>
              {/* Column headers (hidden on very narrow screens) */}
              <div className="diff-head" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--status-danger)' }}>Old</span>
                <span style={{ width: '2rem' }} />
                <span style={{ fontSize: '0.65rem', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--status-success)' }}>New</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {flatKeys.map((key) => {
                  const oldVal = oldValues[key] ?? metadata[`old_${key}`] ?? metadata[key]?.old ?? '';
                  const newVal = newValues[key] ?? metadata[`new_${key}`] ?? metadata[key]?.new ?? '';
                  return (
                    <div key={key} className="diff-row" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '0.5rem', alignItems: 'stretch' }}>
                      <div style={{ padding: '0.65rem 0.8rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', minWidth: 0 }}>
                        <div style={{ fontSize: '0.6rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', marginBottom: '0.2rem' }}>{prettyLabel(key)}</div>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--admin-text-primary)', overflowWrap: 'anywhere' }}>{renderValue(oldVal)}</div>
                      </div>
                      <div className="diff-arrow" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-secondary)' }}>
                        <ArrowRight size={16} className="diff-arrow-right" aria-hidden="true" />
                        <ArrowLeft size={16} className="diff-arrow-left" aria-hidden="true" />
                      </div>
                      <div style={{ padding: '0.65rem 0.8rem', background: 'rgba(var(--admin-brand-rgb), 0.06)', border: '1px solid rgba(var(--admin-brand-rgb), 0.25)', borderRadius: 'var(--admin-radius-sm)', minWidth: 0 }}>
                        <div style={{ fontSize: '0.6rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', marginBottom: '0.2rem' }}>{prettyLabel(key)}</div>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--admin-text-primary)', overflowWrap: 'anywhere' }}>{renderValue(newVal)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div style={{ padding: '1rem 1.5rem 1.5rem', borderTop: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              minHeight: '2.75rem', padding: '0.75rem 1.5rem',
              background: 'var(--admin-bg)', color: 'var(--admin-text-primary)',
              border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)',
              fontWeight: 950, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>

      {/* 375px-safe: stack the columns and rotate the arrow to point down. */}
      <style>{`
        @media (max-width: 480px) {
          .diff-head { display: none !important; }
          .diff-row { grid-template-columns: 1fr !important; }
          .diff-arrow { padding: 0.15rem 0; }
          .diff-arrow-right { display: none; }
        }
        @media (min-width: 481px) {
          .diff-arrow-left { display: none; }
        }
      `}</style>
    </div>
  );
};

export default ChangeDiffModal;