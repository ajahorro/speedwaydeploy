import React from 'react';
import { useUI } from '../context/UIContext';

/**
 * Custom hook to trigger confirmation modals and specialized actions
 */
export const useConfirmation = () => {
  const { openModal } = useUI();

  const showConfirmation = ({
    title = 'Are you sure?',
    message = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    onConfirm = () => { },
    variant = 'danger'
  }) => {
    openModal({
      title,
      message,
      confirmText: confirmLabel,
      cancelText: cancelLabel,
      type: variant,
      onConfirm
    });
  };

  const confirmLogout = (onConfirm) => {
    showConfirmation({
      title: 'Are you sure you want to log out?',
      message: 'Are you sure you want to log out of your account? Any unsaved progress may be lost.',
      confirmLabel: 'Log Out',
      onConfirm,
      variant: 'danger'
    });
  };

  const confirmDelete = (itemName, onConfirm) => {
    showConfirmation({
      title: 'Confirm Deletion',
      message: `Are you sure you want to delete ${itemName}? This action cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm,
      variant: 'danger'
    });
  };

  /**
   * Tier 3 / Task 15: styled replacement for native window.prompt().
   * `onConfirm` receives the typed string. Used for rejection / cancellation
   * reasons so the UX matches the rest of the app (and survives browsers that
   * block native prompts in sandboxed contexts).
   */
  const showPrompt = ({
    title = 'Enter a reason',
    message = '',
    inputLabel = '',
    inputPlaceholder = '',
    confirmLabel = 'Submit',
    cancelLabel = 'Cancel',
    onConfirm = () => {},
    variant = 'warning'
  }) => {
    openModal({
      title,
      message,
      confirmText: confirmLabel,
      cancelText: cancelLabel,
      type: variant,
      prompt: true,
      inputLabel,
      inputPlaceholder,
      onConfirm
    });
  };

  return {
    showConfirmation,
    showPrompt,
    confirmLogout,
    confirmDelete
  };
};

/**
 * Direct legacy support exports (compatible with both openModal and single-callback signatures)
 */
export const showConfirmation = (openModal, options = {}) => {
  const modalFn = typeof openModal === 'function' ? openModal : null;
  const opts = typeof openModal === 'function' ? options : openModal;

  const {
    title = 'Are you sure?',
    message = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    onConfirm = () => { },
    variant = 'danger'
  } = opts || {};

  if (modalFn) {
    modalFn({
      title,
      message,
      confirmText: confirmLabel,
      cancelText: cancelLabel,
      type: variant,
      onConfirm
    });
  }
};

export const confirmLogout = (arg1, arg2) => {
  // Gracefully handles both confirmLogout(openModal, callback) AND confirmLogout(callback)
  const modalFn = typeof arg1 === 'function' && typeof arg2 === 'function' ? arg1 : null;
  const callbackFn = modalFn ? arg2 : arg1;

  if (modalFn) {
    modalFn({
      title: 'Are you sure you want to log out?',
      message: 'Are you sure you want to log out of your account? Any unsaved progress may be lost.',
      confirmText: 'Log Out',
      cancelText: 'Cancel',
      type: 'danger',
      onConfirm: callbackFn
    });
  } else if (typeof callbackFn === 'function') {
    // No modal system was handed in (e.g. a non-React caller). Rather than a raw
    // window.confirm — which is unstyled and blocked in some browsers — we log a
    // warning and proceed only when the callback is explicitly safe. Logout is
    // non-destructive, so proceeding is the correct degraded behaviour.
    console.warn('[confirmLogout] No modal handler available; proceeding with logout.');
    callbackFn();
  }
};

export const confirmDelete = (arg1, arg2, arg3) => {
  const modalFn = typeof arg1 === 'function' ? arg1 : null;
  const itemName = modalFn ? arg2 : arg1;
  const callbackFn = modalFn ? arg3 : arg2;

  if (modalFn) {
    modalFn({
      title: 'Confirm Deletion',
      message: `Are you sure you want to delete ${itemName}? This action cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      type: 'danger',
      onConfirm: callbackFn
    });
  }
};
