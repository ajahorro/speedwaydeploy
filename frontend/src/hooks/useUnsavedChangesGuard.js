import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * useUnsavedChangesGuard
 * ============================================================================
 * Batch 7 / Step 7.5 — Task B: `isDirty` unsaved-changes route guard.
 *
 * Blocks two escape routes while a form has unsaved edits:
 *   1. In-app navigation (react-router) — via a confirm gate the caller wires
 *      into its own navigation actions, plus a `beforeunload` listener that
 *      covers the browser Back button and any router-driven navigation.
 *   2. Full page refresh / tab close — via the native `beforeunload` prompt.
 *
 * Usage:
 *   const guard = useUnsavedChangesGuard(isDirty, { onBlocked });
 *   // guard.confirmNavigation(next)  -> returns true when safe to proceed
 *   // <LeaveGuardModal {...guard.modalProps} /> for a custom styled prompt
 */

const DEFAULT_MESSAGE = 'You have unsaved changes. Leave without saving?';

export const useUnsavedChangesGuard = (isDirty, options = {}) => {
  const { message = DEFAULT_MESSAGE } = options;
  const [pendingLeave, setPendingLeave] = useState(null);
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;

  // Native refresh / tab-close guard.
  useEffect(() => {
    const handler = (e) => {
      if (!dirtyRef.current) return undefined;
      e.preventDefault();
      e.returnValue = message;
      return message;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [message]);

  /**
   * Decide whether a navigation may proceed.
   * @param {Function} [action] - the navigation to run when approved.
   * @returns {boolean} true when the caller may navigate immediately.
   */
  const confirmNavigation = useCallback((action) => {
    if (!dirtyRef.current) {
      if (typeof action === 'function') action();
      return true;
    }
    setPendingLeave(() => action || null);
    return false;
  }, []);

  const modalProps = {
    open: pendingLeave !== null || false,
    message,
    onStay: () => setPendingLeave(null),
    onLeave: () => {
      const action = pendingLeave;
      setPendingLeave(null);
      if (typeof action === 'function') action();
    },
    // Exposed so a page can open the prompt without a pending action.
    request: () => setPendingLeave(() => null),
  };

  return { confirmNavigation, modalProps, isDirty: Boolean(isDirty) };
};

export default useUnsavedChangesGuard;