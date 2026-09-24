import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * useUnsavedChangesGuard
 * ============================================================================
 * Batch 7 / Step 7.5 — Task B: `isDirty` unsaved-changes route guard.
 *
 * Blocks three escape routes while a form has unsaved edits:
 *   1. In-app navigation (react-router) — via a confirm gate the caller wires
 *      into its own navigation actions.
 *   2. Full page refresh / tab close — via the native `beforeunload` prompt.
 *   3. BROWSER BACK / FORWARD — via a `popstate` trap. In a BrowserRouter SPA the
 *      browser Back button does NOT fire `beforeunload`; it drives a history
 *      `popstate` that React Router consumes silently. We push a sentinel history
 *      entry so a Back press is caught, restore the URL, and surface the same
 *      confirm gate the in-app actions use.
 *
 * Usage:
 *   const guard = useUnsavedChangesGuard(isDirty, { onBlocked });
 *   // guard.confirmNavigation(next)  -> returns true when safe to proceed
 *   // <LeaveGuardModal {...guard.modalProps} /> for a custom styled prompt
 */

const DEFAULT_MESSAGE = 'You have unsaved changes. Leave without saving?';

export const useUnsavedChangesGuard = (isDirty, options = {}) => {
  const { message = DEFAULT_MESSAGE, onBlocked } = options;
  const [pendingLeave, setPendingLeave] = useState(null);
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  // Tracks whether we have armed a sentinel history entry for the back-button
  // trap at the CURRENT url, so we only push one per navigation.
  const sentinelArmed = useRef(false);

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

  // Browser Back / Forward trap. While dirty, we keep one extra history entry in
  // front of the current one; a Back press pops it, firing `popstate`. We then
  // immediately re-push the current URL (so the address bar is unchanged) and ask
  // the user via the same modal. If they confirm leaving, we step back for real.
  useEffect(() => {
    const onPopState = () => {
      if (!dirtyRef.current) return;
      // Re-arm the sentinel so the URL stays put, then surface the prompt.
      window.history.pushState(null, '', window.location.href);
      sentinelArmed.current = true;
      if (typeof onBlocked === 'function') onBlocked();
      setPendingLeave(() => 'BACK_NAVIGATION');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [onBlocked]);

  // Arm the sentinel history entry whenever the form becomes dirty, and disarm it
  // when the user saves/clears the form. This is what makes a Back press land in
  // the `popstate` handler above instead of silently leaving the page.
  useEffect(() => {
    if (!isDirty) {
      sentinelArmed.current = false;
      return undefined;
    }
    if (!sentinelArmed.current) {
      window.history.pushState(null, '', window.location.href);
      sentinelArmed.current = true;
    }
    return undefined;
  }, [isDirty]);

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
      // A browser-Back prompt has no caller action: perform the real history
      // step now that the user has confirmed they want to leave.
      if (action === 'BACK_NAVIGATION') {
        sentinelArmed.current = false;
        window.history.back();
        return;
      }
      if (typeof action === 'function') action();
    },
    // Exposed so a page can open the prompt without a pending action.
    request: () => setPendingLeave(() => null),
  };

  return { confirmNavigation, modalProps, isDirty: Boolean(isDirty) };
};

export default useUnsavedChangesGuard;