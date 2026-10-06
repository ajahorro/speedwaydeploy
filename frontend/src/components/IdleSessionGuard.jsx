import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { IDLE_WARNING_SECONDS, LAST_ACTIVITY_KEY, idleLimitMinutesFor } from '../config/sessionPolicy';
import { idleState } from '../utils/idleSession';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from './ui/alert-dialog';

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
const readLast = () => {
  try { return Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || 0; } catch { return 0; }
};
const writeLast = (value) => {
  try { localStorage.setItem(LAST_ACTIVITY_KEY, String(value)); } catch { /* storage unavailable: this tab still works on its own */ }
};

/**
 * Ends a signed-in session after a period without activity (config/sessionPolicy.js).
 *  - A warning with a countdown appears shortly before; "Stay signed in" keeps the session.
 *  - Activity in any open tab keeps every tab signed in (the last-activity time is shared).
 *  - While the warning is open, ordinary clicks elsewhere do not count, only the button does.
 *  - Administrator and staff sign-outs are written to the audit log.
 *  - The user lands on the login page with a message that explains why.
 * Booking drafts are saved as they are typed, so nothing the user was filling in is lost.
 */
export default function IdleSessionGuard() {
  const { user, profile, signOut, isInitialized } = useAuth();
  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(IDLE_WARNING_SECONDS);
  const warningRef = useRef(false);
  const signingOutRef = useRef(false);
  const lastWriteRef = useRef(0);
  const role = String(profile?.role || '').toUpperCase();
  const signedIn = Boolean(user?.id && profile?.id);

  const stay = useCallback(() => {
    const now = Date.now();
    writeLast(now);
    lastWriteRef.current = now;
    warningRef.current = false;
    setWarning(false);
  }, []);

  const endSession = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    try {
      if (role === 'ADMIN' || role === 'STAFF') await supabase.rpc('record_idle_signout');
    } catch { /* the audit entry is best effort; the sign-out must still happen */ }
    await signOut();
    window.location.assign('/login?reason=idle');
  }, [role, signOut]);

  useEffect(() => {
    if (!signedIn) {
      signingOutRef.current = false;
      warningRef.current = false;
      setWarning(false);
      // Signed out (not merely still loading): forget the old activity time so the next sign-in starts fresh.
      if (isInitialized) { try { localStorage.removeItem(LAST_ACTIVITY_KEY); } catch { /* ignore */ } }
      return undefined;
    }
    // A page load with a saved session keeps the stored time: a browser reopened after the limit is signed out at once.
    if (!readLast()) writeLast(Date.now());

    const limitMs = idleLimitMinutesFor(role) * 60000;
    const warningMs = Math.min(IDLE_WARNING_SECONDS * 1000, limitMs / 2);

    const noteActivity = () => {
      if (warningRef.current) return; // only the "Stay signed in" button counts during the warning
      const now = Date.now();
      if (now - lastWriteRef.current < 2000) return;
      lastWriteRef.current = now;
      writeLast(now);
    };
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, noteActivity, { capture: true, passive: true }));

    const tick = () => {
      const { state, secondsLeft: left } = idleState(Date.now(), readLast(), limitMs, warningMs);
      if (state === 'expired') { endSession(); return; }
      if (state === 'warning') {
        warningRef.current = true;
        setSecondsLeft(left);
        setWarning(true);
      } else if (warningRef.current) {
        warningRef.current = false; // another tab said "stay signed in"
        setWarning(false);
      }
    };
    const timer = setInterval(tick, 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    tick();

    return () => {
      clearInterval(timer);
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, noteActivity, { capture: true }));
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, [signedIn, role, endSession, isInitialized]);

  if (!signedIn) return null;

  return (
    <AlertDialog open={warning}>
      <AlertDialogContent className="ui-root" style={{ zIndex: 100000 }}>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you still there?</AlertDialogTitle>
          <AlertDialogDescription>
            For your security you will be signed out in <strong>{secondsLeft}</strong> second{secondsLeft === 1 ? '' : 's'} because there has been no activity. Anything you were typing in a booking is saved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={endSession}>Sign out now</AlertDialogCancel>
          <AlertDialogAction onClick={stay}>Stay signed in</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
