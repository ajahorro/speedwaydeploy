import { useCallback, useRef, useState } from 'react';
import { useUI } from '../context/UIContext';

/**
 * One way to ask "are you sure?" before a state-changing action.
 *
 *   const { confirmThen, pending } = useConfirmAction();
 *   <button disabled={pending} onClick={() => confirmThen({
 *     title: 'Cancel booking?', message: '...', confirmText: 'Cancel booking', type: 'danger'
 *   }, () => cancelBooking(id))}>
 *
 * - Shows the app's single confirmation modal (UIContext.openModal).
 * - The action only runs after Confirm; Cancel or closing the modal does nothing.
 * - `pending` is true while the action runs, and a second confirmation cannot
 *   start the same action again (double-click / double-submit guard).
 * - If the action receives a value (prompt-style modal with `prompt: true`),
 *   it is passed through.
 */
export const useConfirmAction = () => {
  const { openModal } = useUI();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const confirmThen = useCallback((options, action) => {
    if (inFlight.current) return;
    openModal({
      type: 'warning',
      confirmText: 'Confirm',
      ...options,
      onConfirm: async (value) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        try {
          await action(value);
        } finally {
          inFlight.current = false;
          setPending(false);
        }
      }
    });
  }, [openModal]);

  return { confirmThen, pending };
};
