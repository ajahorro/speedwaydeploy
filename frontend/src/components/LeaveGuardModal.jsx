import React from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * LeaveGuardModal
 * ============================================================================
 * Batch 7 / Step 7.5 — Task B: the styled prompt shown by
 * `useUnsavedChangesGuard` when a user tries to leave a form with unsaved edits.
 *
 * Styling: native tokens only; 375px-safe (stacked, full-width buttons).
 */
const LeaveGuardModal = ({ open, message, onStay, onLeave }) => {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-guard-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 100001,
        background: 'var(--modal-overlay)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
    >
      <div
        style={{
          background: 'var(--admin-card)', border: '1px solid var(--admin-border)',
          borderRadius: 'var(--admin-radius-lg, var(--admin-radius))',
          boxShadow: 'var(--modal-shadow)', width: '100%', maxWidth: '420px', padding: '1.5rem',
        }}
      >
        <div style={{ display: 'flex', gap: '0.85rem', alignItems: 'flex-start' }}>
          <span style={{ width: '42px', height: '42px', flexShrink: 0, borderRadius: 'var(--admin-radius-sm)', background: 'rgba(245, 158, 11, 0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <AlertTriangle size={20} color="var(--status-warning)" aria-hidden="true" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 id="leave-guard-title" style={{ margin: 0, fontSize: '1rem', fontWeight: 950, color: 'var(--admin-text-primary)' }}>
              Unsaved Changes
            </h3>
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', fontWeight: 600, color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
              {message || 'You have unsaved changes. Leave without saving?'}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onStay}
            style={{
              flex: '1 1 130px', minHeight: '2.75rem', padding: '0.85rem 1rem',
              background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)',
              border: 'none', borderRadius: 'var(--admin-radius-sm)',
              fontWeight: 950, fontSize: '0.78rem', textTransform: 'uppercase', cursor: 'pointer',
            }}
          >
            Stay
          </button>
          <button
            type="button"
            onClick={onLeave}
            style={{
              flex: '1 1 130px', minHeight: '2.75rem', padding: '0.85rem 1rem',
              background: 'var(--admin-bg)', color: 'var(--status-danger)',
              border: '1px solid var(--status-danger)', borderRadius: 'var(--admin-radius-sm)',
              fontWeight: 950, fontSize: '0.78rem', textTransform: 'uppercase', cursor: 'pointer',
            }}
          >
            Leave
          </button>
        </div>
      </div>
    </div>
  );
};

export default LeaveGuardModal;