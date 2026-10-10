import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { X, CheckCircle, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import toastManager from '../utils/toastManager';
import { toastChrome } from '../utils/toastChrome';

const UIContext = createContext();

export const UIProvider = ({ children }) => {
  const [modal, setModal] = useState(null); // { title, message, onConfirm, onCancel, confirmText, cancelText, type, prompt }
  // Tier 3 / Task 15: the value typed into a prompt-style modal. Kept in its own
  // state so re-renders of the modal don't wipe what the user is typing.
  const [promptValue, setPromptValue] = useState('');

  // Modal actions
  const openModal = useCallback((options) => {
    setPromptValue(options.inputValue || '');
    setModal({
      title: options.title || 'Are you sure?',
      message: options.message || '',
      confirmText: options.confirmText || 'Confirm',
      // `cancelText: null` intentionally renders a SINGLE-action info modal
      // (no cancel button) — used by read-only dialogs like the Legal documents.
      cancelText: options.cancelText === undefined ? 'Cancel' : options.cancelText,
      onConfirm: options.onConfirm || null,
      onCancel: options.onCancel || null,
      type: options.type || 'info', // 'danger' | 'warning' | 'info' | 'success'
      // Tier 3 / Task 15: when true the modal renders a text input and passes the
      // entered string to onConfirm(value), replacing native window.prompt().
      prompt: Boolean(options.prompt),
      inputLabel: options.inputLabel || '',
      inputPlaceholder: options.inputPlaceholder || '',
      inputRequired: options.inputRequired !== false,
    });
  }, []);

  const closeModal = useCallback((triggeredByX = false) => {
    if (modal) {
      if (triggeredByX && modal.onCancel) {
        modal.onCancel();
      }
      setModal(null);
    }
  }, [modal]);

  // Tell the toast manager when a blocking surface owns the screen. While a
  // modal is open the manager suppresses BACKGROUND toasts (Realtime booking
  // alerts) so they cannot paint over a modal the user is reading — the
  // reported defect where an admin alert covered the Official Receipt.
  useEffect(() => {
    if (!modal) return undefined;
    toastManager.notifyModalOpened();
    return () => toastManager.notifyModalClosed();
  }, [modal]);

  // Toast actions
  //
  // Batch 7 / Step 7.3 — TOAST CONSOLIDATION.
  // This provider used to render its own bespoke toast stack (the old
  // "Category B" renderer). That meant two independent toast engines coexisted:
  // the context stack AND react-hot-toast — so some notifications were styled one
  // way and some the other, and neither respected a single source of truth.
  //
  // `showToast` is now a thin, backwards-compatible adapter over react-hot-toast
  // (the canonical engine, hosted by the single <Toaster/> in main.jsx). Every
  // existing `showToast(msg, type)` / `showToast.success(msg)` call site keeps
  // working unchanged, but now routes through the one real toast engine with
  // the shared token chrome.
  //
  // It routes through `toastManager` (not react-hot-toast directly) so the
  // dedupe + 2-toast cap apply to context toasts too. Without that, a context
  // toast and a direct `toast.*()` call could still stack past the cap.
  const showToast = useCallback((message, type = 'success', options = {}) => {
    const { id, background, ...rest } = options || {};
    const opts = { ...toastChrome, ...rest };
    if (id !== undefined) opts.id = id;
    // `background: true` marks an ambient toast that must not cover a modal.
    if (background) opts.background = true;

    switch (type) {
      case 'error':
        return toastManager.error(message, opts);
      case 'warning':
        return toastManager.warning(message, opts);
      case 'loading':
        return toastManager.loading(message, opts);
      case 'info':
        return toastManager.info(message, opts);
      case 'success':
      default:
        return toastManager.success(message, opts);
    }
  }, []);

  // Convenience helpers, parity with the react-hot-toast API so callers can use
  // either entry point interchangeably.
  showToast.success = (msg, opts) => showToast(msg, 'success', opts);
  showToast.error = (msg, opts) => showToast(msg, 'error', opts);
  showToast.warning = (msg, opts) => showToast(msg, 'warning', opts);
  showToast.info = (msg, opts) => showToast(msg, 'info', opts);
  showToast.loading = (msg, opts) => showToast(msg, 'loading', opts);
  showToast.dismiss = (id) => toastManager.dismiss(id);

  // Map types to colors and icons
  const getModalStyles = (type) => {
    switch (type) {
      case 'danger':
        return {
          brandColor: 'var(--status-danger)',
          icon: <AlertCircle size={28} color="var(--status-danger)" />,
          buttonBg: 'var(--status-danger)',
        };
      case 'warning':
        return {
          brandColor: 'var(--status-warning)',
          icon: <AlertTriangle size={28} color="var(--status-warning)" />,
          buttonBg: 'var(--status-warning)',
        };
      case 'success':
        return {
          brandColor: 'var(--status-success)',
          icon: <CheckCircle size={28} color="var(--status-success)" />,
          buttonBg: 'var(--status-success)',
        };
      default:
        return {
          brandColor: 'var(--admin-brand, #E61E2A)',
          icon: <Info size={28} color="var(--admin-brand, #E61E2A)" />,
          buttonBg: 'var(--admin-brand, #E61E2A)',
        };
    }
  };

  return (
    <UIContext.Provider value={{ openModal, closeModal, showToast, modal }}>
      {children}

      {/* Category A: Blocking Center-Screen Modals */}
      {modal && (
        <div className="app-modal-overlay" style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'var(--modal-overlay)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 99999,
          padding: 'clamp(0.75rem, 4vw, 1.5rem)',
          // dvh, not vh: on mobile browsers `100vh` excludes the retractable URL
          // bar, so a full-height overlay can sit partly BEHIND it. `dvh` tracks
          // the visible area, and `100%` is the fallback for older engines.
          height: '100dvh',
          boxSizing: 'border-box',
          animation: 'fadeIn 0.25s ease-out'
        }}>
          <div className="app-modal" style={{
            background: 'var(--admin-card)',
            border: `1px solid ${getModalStyles(modal.type).brandColor}40`,
            borderRadius: 'var(--admin-radius)',
            maxWidth: '500px',
            width: '100%',
            // ── Height discipline ─────────────────────────────────────────
            // Previously the card had NO max-height and `overflow: hidden`, while
            // only the inner content was capped at a hard `65vh`. So a long modal
            // grew the card past the viewport and the overlay — which cannot
            // scroll — clipped the actions off the bottom with no way to reach
            // them. The card is now the scroll boundary and is always shorter
            // than the overlay, so the action row stays reachable.
            maxHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: 'var(--modal-shadow)',
            position: 'relative',
            overflow: 'hidden',
            animation: 'modalSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
          }}>
            {/* Top right X close icon - acts as cancel/dismiss */}
            <button
              onClick={() => closeModal(true)}
              style={{
                position: 'absolute',
                top: '1rem',
                right: '1rem',
                background: 'transparent',
                border: 'none',
                color: 'var(--admin-text-secondary)',
                cursor: 'pointer',
                padding: '0.25rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '4px',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--admin-text-primary)';
                e.currentTarget.style.background = 'var(--modal-hover-bg)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--admin-text-secondary)';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <X size={18} />
            </button>

            {/* Modal Content */}
            {/* `minHeight: 0` is required for a flex child to actually scroll
                rather than expand its parent. `65vh` was a fixed cap that left a
                huge dead area on tall screens and still overflowed on short ones;
                flexing to the remaining space adapts to both. */}
            <div className="app-modal-content" style={{ padding: '2rem 2rem 1.5rem 2rem', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', marginBottom: '1rem' }}>
                {getModalStyles(modal.type).icon}
                <div style={{ flex: 1 }}>
                  <h3 style={{
                    margin: 0,
                    fontSize: '1.25rem',
                    fontWeight: '900',
                    color: 'var(--admin-text-primary)',
                    letterSpacing: '0.5px',
                    textTransform: 'uppercase'
                  }}>
                    {modal.title}
                  </h3>
                  <div style={{
                    marginTop: '0.75rem',
                    fontSize: '0.9rem',
                    color: 'var(--admin-text-secondary)',
                    lineHeight: '1.6',
                    fontWeight: '500'
                  }}>
                    {modal.message}
                  </div>

                  {/* Tier 3 / Task 15: inline reason input, replacing window.prompt(). */}
                  {modal.prompt && (
                    <div style={{ marginTop: '1rem' }}>
                      {modal.inputLabel && (
                        <label style={{
                          display: 'block',
                          fontSize: '0.65rem',
                          fontWeight: '900',
                          color: 'var(--admin-text-secondary)',
                          textTransform: 'uppercase',
                          letterSpacing: '1px',
                          marginBottom: '0.5rem'
                        }}>
                          {modal.inputLabel}
                        </label>
                      )}
                      <textarea
                        autoFocus
                        value={promptValue}
                        onChange={(e) => setPromptValue(e.target.value)}
                        placeholder={modal.inputPlaceholder}
                        rows={3}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '0.75rem 1rem',
                          background: 'var(--admin-input-bg, var(--admin-bg))',
                          color: 'var(--admin-text-primary)',
                          border: '1px solid var(--admin-input-border, var(--admin-border))',
                          borderRadius: '6px',
                          fontSize: '0.85rem',
                          fontWeight: '600',
                          fontFamily: 'inherit',
                          resize: 'vertical',
                          outline: 'none'
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="app-modal-actions" style={{
              background: 'var(--admin-sidebar)',
              padding: '1rem 2rem',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.75rem',
              // Never let the action row be squeezed or scrolled away: it is the
              // only way to dismiss the modal.
              flex: '0 0 auto',
              flexWrap: 'wrap',
              borderTop: '1px solid var(--admin-border)'
            }}>
              {modal.cancelText !== null && (
              <button
                onClick={() => {
                  if (modal.onCancel) modal.onCancel();
                  closeModal();
                }}
                style={{
                  padding: '0.6rem 1.25rem',
                  borderRadius: '4px',
                  background: 'transparent',
                  border: '1px solid var(--admin-input-border)',
                  color: 'var(--admin-text-secondary)',
                  fontWeight: '700',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'var(--admin-text-primary)';
                  e.currentTarget.style.borderColor = 'var(--admin-text-secondary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--admin-text-secondary)';
                  e.currentTarget.style.borderColor = 'var(--admin-input-border)';
                }}
              >
                {modal.cancelText}
              </button>
              )}
              <button
                onClick={() => {
                  // Tier 3 / Task 15: a prompt modal refuses to submit an empty
                  // value so the reason can never be silently blank.
                  if (modal.prompt && modal.inputRequired !== false && !promptValue.trim()) {
                    showToast('Please enter a reason before continuing.', 'error');
                    return;
                  }
                  const onConfirm = modal.onConfirm;
                  const value = modal.prompt ? promptValue.trim() : undefined;
                  setModal(null);
                  setPromptValue('');
                  if (onConfirm) onConfirm(value);
                }}
                style={{
                  padding: '0.6rem 1.25rem',
                  borderRadius: '4px',
                  background: getModalStyles(modal.type).buttonBg,
                  border: 'none',
                  color: 'var(--admin-text-on-brand)',
                  fontWeight: '700',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.filter = 'brightness(1.1)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.filter = 'brightness(1)';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                {modal.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toasts are NO LONGER rendered here. Batch 7 / Step 7.3 consolidated all
          toast output onto react-hot-toast, hosted by the single <Toaster/> in
          main.jsx (styled with the shared token chrome). The old bespoke stack
          is gone so there is exactly one toast engine in the app. */}

      {/* Style Animations (Injected via style block) */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes modalSlideIn {
          from { transform: scale(0.9) translateY(20px); opacity: 0; }
          to { transform: scale(1) translateY(0); opacity: 1; }
        }

        /*
         * Mobile: a centred dialog with 2rem of horizontal padding wastes most of
         * a 360px screen and forces unnecessary inner scrolling. Tighten the
         * chrome, and make the action buttons full-width so the primary action is
         * an easy tap target rather than a small pill in the bottom-right corner.
         */
        @media (max-width: 480px) {
          .app-modal-content { padding: 1.5rem 1.25rem 1rem 1.25rem !important; }
          .app-modal-actions {
            padding: 0.875rem 1.25rem !important;
            flex-direction: column-reverse !important;
            align-items: stretch !important;
          }
          .app-modal-actions > button {
            width: 100% !important;
            padding: 0.8rem 1.25rem !important;
          }
        }

        /*
         * Respect the user's motion preference. The slide/scale spring is
         * decorative; for someone who has asked the OS for reduced motion it is
         * uncomfortable, and there is no reason to keep it.
         */
        @media (prefers-reduced-motion: reduce) {
          .app-modal-overlay, .app-modal { animation: none !important; }
        }
      `}</style>
    </UIContext.Provider>
  );
};

export const useUI = () => {
  const context = useContext(UIContext);
  if (!context) {
    throw new Error('useUI must be used within a UIProvider');
  }
  return context;
};
