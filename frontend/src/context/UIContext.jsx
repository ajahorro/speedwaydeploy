import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { CheckCircle, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import toastManager from '../utils/toastManager';
import { toastChrome } from '../utils/toastChrome';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const UIContext = createContext();

export const UIProvider = ({ children }) => {
  const [modal, setModal] = useState(null); // { title, message, onConfirm, onCancel, confirmText, cancelText, type, prompt }
  // Tier 3 / Task 15: the value typed into a prompt-style modal. Kept in its own
  // state so re-renders of the modal don't wipe what the user is typing.
  const [promptValue, setPromptValue] = useState('');
  // The last box stays drawn while it fades out, so it never flashes empty.
  const lastModal = useRef(null);
  if (modal) lastModal.current = modal;
  const shown = modal || lastModal.current;

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

      {/* The app's one confirmation box (shadcn AlertDialog, so it can sit on top of any other pop-up). */}
      <AlertDialog open={Boolean(modal)} onOpenChange={(open) => { if (!open) closeModal(true); }}>
        <AlertDialogContent className="ui-root max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
          {shown && (
            <>
              <AlertDialogHeader className="pr-6">
                <AlertDialogTitle className="flex items-center gap-2" style={{ color: getModalStyles(shown.type).brandColor }}>
                  {getModalStyles(shown.type).icon}
                  <span className="text-foreground">{shown.title}</span>
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="whitespace-pre-line text-sm leading-relaxed">{shown.message}</div>
                </AlertDialogDescription>
              </AlertDialogHeader>

              {/* Inline reason input (replaces window.prompt). */}
              {shown.prompt && (
                <div className="grid gap-1.5">
                  {shown.inputLabel && <Label htmlFor="app-modal-prompt">{shown.inputLabel}</Label>}
                  <Textarea
                    id="app-modal-prompt"
                    autoFocus
                    value={promptValue}
                    onChange={(e) => setPromptValue(e.target.value)}
                    placeholder={shown.inputPlaceholder}
                    rows={3}
                  />
                </div>
              )}

              <AlertDialogFooter>
                {shown.cancelText !== null && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (!modal) return; // already closing: ignore a second click while it fades out
                      if (shown.onCancel) shown.onCancel();
                      closeModal();
                    }}
                  >
                    {shown.cancelText}
                  </Button>
                )}
                <Button
                  variant={shown.type === 'danger' ? 'destructive' : 'default'}
                  onClick={() => {
                    if (!modal) return; // already closing: ignore a second click while it fades out
                    // A prompt modal refuses to submit an empty value so the reason can never be silently blank.
                    if (shown.prompt && shown.inputRequired !== false && !promptValue.trim()) {
                      showToast('Please enter a reason before continuing.', 'error');
                      return;
                    }
                    const onConfirm = modal.onConfirm;
                    const value = modal.prompt ? promptValue.trim() : undefined;
                    setModal(null);
                    setPromptValue('');
                    if (onConfirm) onConfirm(value);
                  }}
                >
                  {shown.confirmText}
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

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
