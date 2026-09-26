import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { logger } from '../utils/logger';
import toast from 'react-hot-toast';
import { BACKEND_URL } from '../config/api';

export const AuthContext = createContext({});

/**
 * Section 1.2 capability probe.
 *
 * The DB-backed login lockout is implemented by three SQL functions
 * (check_login_lock / register_failed_login / clear_login_lock) added in
 * migration 20260927000001. When that migration has NOT been applied to the
 * connected database, every `supabase.rpc(...)` call to them resolves to a
 * PostgREST 404 (PGRST202) — the surrounding try/catch keeps login working, but
 * the browser console fills with red 404s on every sign-in.
 *
 * Rather than swallow them, we probe ONCE per page load and, if the functions
 * are absent, skip the calls entirely. The feature turns on automatically the
 * moment the migration is applied — no code change, no rebuild.
 */
let lockoutAvailabilityPromise = null;

/**
 * Resolves to true when the lockout RPCs are callable, false when the migration
 * is not applied. Probed once per session and shared by every caller.
 *
 * Detection uses a single check_login_lock call as the sentinel; PostgREST
 * reports a missing function as PGRST202, which the client returns (not throws).
 * The result is memoized so at most ONE probe request is made per page load —
 * repeated logins add no traffic. Once migration 20260927000001 is applied the
 * call succeeds and the feature switches on with no code change.
 */
const isMissingRpcError = (error) =>
  error?.code === 'PGRST202' ||
  error?.code === '42883' ||
  /could not find the function/i.test(error?.message || '');

const probeLockoutSupport = () => {
  if (!lockoutAvailabilityPromise) {
    lockoutAvailabilityPromise = supabase
      .rpc('check_login_lock', { p_email: '__capability_probe__@speedway.local' })
      .then(({ error }) => {
        if (error && isMissingRpcError(error)) {
          logger.warn('Login lockout RPCs absent — migration 20260927000001 not applied. Feature disabled.');
          return false;
        }
        return true;
      })
      .catch(() => false);
  }
  return lockoutAvailabilityPromise;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState(null);

  const activeFetchRef = useRef(0);
  const fetchedForRef = useRef(null);
  const profileRef = useRef(null);

  // Sync ref with state
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  const signOut = async () => {
    try {
      logger.auth('Initiating sign out sequence...');
      setUser(null);
      setProfile(null);
      fetchedForRef.current = null;
      await supabase.auth.signOut();
      logger.auth('Sign out complete.');
    } catch (err) {
      logger.error('Sign Out Error', err);
    } finally {
      setLoading(false);
      setIsInitialized(true);
    }
  };

  const fetchProfile = useCallback(async (userId, source = 'unknown', force = false) => {
    if (!userId) return;

    if (!force && fetchedForRef.current === userId && profileRef.current) return;

    const fetchId = ++activeFetchRef.current;
    fetchedForRef.current = userId;

    try {
      setError(null);
      setLoading(true);

      const { data, error: supabaseError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (fetchId !== activeFetchRef.current) {
        logger.auth(`Ignoring stale response (ID: ${fetchId})`);
        return;
      }

      if (supabaseError) throw supabaseError;

      if (data) {
        if (data.is_active === false) {
          const deactDate = new Date(data.deactivated_at);
          const now = new Date();
          const diffDays = Math.ceil((now - deactDate) / (1000 * 60 * 60 * 24));

          if (diffDays <= 15) {
            const shouldRecover = window.confirm(`This account is DEACTIVATED (Day ${diffDays}/15). Would you like to RECOVER and reactivate it?`);
            if (shouldRecover) {
              const res = await recoverAccount(userId);
              if (res.success) return; // fetchProfile will be called again inside recoverAccount
            }
          } else {
            toast.error('Account has been permanently purged after grace period.');
          }
          await signOut();
          return;
        }
        setProfile(data);
      } else {
        logger.warn(`Profile missing for user (ID: ${fetchId})`);
        setProfile(null);
      }
    } catch (err) {
      if (fetchId !== activeFetchRef.current) return;
      logger.error(`Sync Error (ID: ${fetchId})`, err);
      setError(err.message);
    } finally {
      if (fetchId === activeFetchRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const initAuth = async () => {
      try {
        logger.auth('Bootstrap initialization starting...');
        const { data: { session } } = await supabase.auth.getSession();

        if (session?.user) {
          setUser(session.user);
          // 🛡️ CRITICAL: Wait for profile before marking as initialized
          // to prevent landing page race conditions
          await fetchProfile(session.user.id, 'BOOTSTRAP');
        }

        setIsInitialized(true);
        logger.auth('Bootstrap complete.');
      } catch (err) {
        logger.error('Bootstrap Error', err);
        setIsInitialized(true);
      } finally {
        setLoading(false);
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'INITIAL_SESSION') return;

      logger.auth(`Event: ${event}`);

      if (session?.user) {
        setUser(session.user);
        if (event === 'SIGNED_IN' && fetchedForRef.current !== session.user.id) {
          fetchProfile(session.user.id, 'LISTENER_SIGN_IN');
        }
      } else {
        setUser(null);
        setProfile(null);
        fetchedForRef.current = null;
        setLoading(false);
        setIsInitialized(true);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signInWithPassword = async (email, password) => {
    logger.auth('Attempting sign in with credentials...');
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail || typeof password !== 'string' || !password) {
      return {
        data: { user: null },
        error: new Error('Enter both your email address and password.')
      };
    }

    // ── Section 1.2: DB-backed lockout ────────────────────────────────────────
    // The lock lives in the DB (profiles.locked_until, evaluated as NOW() <
    // locked_until), NOT in localStorage. Refreshing or reopening the browser
    // therefore cannot clear it. We check BEFORE submitting credentials so a
    // locked user never burns an auth round-trip.
    //
    // Skipped entirely when the lockout RPCs are not deployed, so an un-migrated
    // database does not spray 404s into the console on every login.
    const lockoutAvailable = await probeLockoutSupport();
    if (lockoutAvailable) {
      try {
        const { data: lockState } = await supabase.rpc('check_login_lock', { p_email: normalizedEmail });
        if (lockState?.locked) {
          const minutes = lockState.minutes_left ?? Math.ceil((lockState.seconds_left || 0) / 60);
          return {
            data: { user: null },
            error: new Error(`Account temporarily locked. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`)
          };
        }
      } catch (lockCheckError) {
        // A failed pre-check must not block a legitimate sign-in; the server-side
        // auth attempt below still enforces everything that matters.
        logger.warn('Lockout pre-check unavailable', lockCheckError);
      }
    }

    try {
      logger.auth('Submitting login credentials', {
        email: normalizedEmail,
        passwordPresent: true
      });
      const result = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
      if (result.error) throw result.error;

      // Success: clear the DB lock and counter so the next session starts clean.
      if (lockoutAvailable) {
        try {
          await supabase.rpc('clear_login_lock', { p_email: normalizedEmail });
        } catch (clearError) {
          logger.warn('Could not clear login lock after success', clearError);
        }
      }

      if (result.data?.user) {
        fetchProfile(result.data.user.id, 'MANUAL_LOGIN');
      }
      return result;
    } catch (authError) {
      logger.auth('Login failed', {
        email: normalizedEmail,
        status: authError?.status,
        code: authError?.code,
        message: authError?.message
      });

      // Record the failure in the DB. At 5 consecutive failures the RPC sets
      // locked_until = now() + 20 minutes and reports the lock back to us.
      let failureError = new Error('Invalid login credentials.');
      if (lockoutAvailable) {
        try {
          const { data: lockState } = await supabase.rpc('register_failed_login', { p_email: normalizedEmail });
          if (lockState?.locked) {
            const minutes = lockState.minutes_left ?? 20;
            failureError = new Error(`Too many failed login attempts. Account locked for ${minutes} minutes.`);
          } else if (typeof lockState?.attempts_remaining === 'number') {
            const used = 5 - lockState.attempts_remaining;
            failureError = new Error(`Invalid login credentials. Attempt ${used} of 5.`);
          }
        } catch (recordError) {
          logger.warn('Failed to register login failure', recordError);
        }
      }

      return {
        data: { user: null },
        error: failureError
      };
    }
  };

  /**
   * FORGOT PASSWORD → always a NEXUS of the LINK flow (see EMAIL AUTH POLICY below).
   *
   * This previously called supabase.auth.resetPasswordForEmail(), which fires
   * SUPABASE's OWN Auth email template and bypasses our branded Resend relay.
   * Supabase's default template renders {{ .Token }} — a 6-digit OTP — so users
   * clicking "Send Recovery Link" received an OTP that no screen ever accepted.
   * We now delegate to the backend relay, which issues a one-time
   * /password-confirmation?token=... LINK that this app actually handles.
   */
  const requestPasswordReset = async (email) => {
    logger.auth('Requesting password reset for:', email);
    const response = await fetch(`${import.meta.env.VITE_BACKEND_URL || window.location.origin}/api/auth/recover-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) {
      throw new Error(result.error || 'Failed to send reset email');
    }
    return result;
  };

  // Deprecated alias kept only so old call sites don't break — it is the SAME
  // LINK flow, never Supabase's OTP template. Prefer requestPasswordReset.
  const resetPassword = requestPasswordReset;

  const changePassword = async (newPassword) => {
    throw new Error('Password changes require current-password verification and email confirmation.');
  };

  const requestPasswordChange = async (currentPassword, newPassword) => {
    if (!user?.email) throw new Error('You must be logged in to change your password.');
    const response = await fetch(`${import.meta.env.VITE_BACKEND_URL || window.location.origin}/api/auth/request-password-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, currentPassword, newPassword })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to send password confirmation email.');
    // Task 16: result carries { emailDelivered, messageId, expiresAt } so callers
    // can confirm the email actually sent (and offer a resend if it did not).
    return result;
  };

  /**
   * Task 16: resend the password-change confirmation email for a still-valid
   * pending request, so a user is never stranded when the first email is lost.
   */
  const resendPasswordChange = async (currentPassword) => {
    if (!user?.email) throw new Error('You must be logged in to resend the confirmation email.');
    const response = await fetch(`${import.meta.env.VITE_BACKEND_URL || window.location.origin}/api/auth/resend-password-confirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, currentPassword })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to resend the confirmation email.');
    return result;
  };

  const updateProfile = async (updates) => {
    if (!user) return;
    logger.auth('Updating user profile...');

    // 🛡️ SCENARIO 16 — STRICT FIELD ALLOWLIST (defence in depth).
    //
    // Previously the raw `updates` object was passed straight to `.update()`.
    // A customer who intercepted their own request could inject
    // `{ role: 'ADMIN' }` and — if RLS were ever permissive — escalate to admin
    // silently. The database now has a column guard (migration
    // 20261018000009), but the client must ALSO refuse to send privileged keys so
    // the widened payload never leaves the browser. We whitelist the exact
    // fields a user may change and strip everything else.
    const SAFE_PROFILE_FIELDS = [
      'first_name', 'last_name', 'phone_number',
      'push_notifications_enabled', 'email_change_temp'
    ];
    const safeUpdates = Object.fromEntries(
      Object.entries(updates || {}).filter(([key]) => SAFE_PROFILE_FIELDS.includes(key))
    );

    const blockedKeys = Object.keys(updates || {}).filter((key) => !SAFE_PROFILE_FIELDS.includes(key));
    if (blockedKeys.length) {
      logger.warn(`[Auth] Ignored non-permitted profile field(s): ${blockedKeys.join(', ')}`);
    }

    if (Object.keys(safeUpdates).length === 0) {
      return profile;
    }

    // Prefer the explicit safe RPC (accepts only safe fields by construction).
    const { data: rpcData, error: rpcError } = await supabase.rpc('update_my_profile', {
      p_first_name: safeUpdates.first_name ?? null,
      p_last_name: safeUpdates.last_name ?? null,
      p_phone_number: safeUpdates.phone_number ?? null,
      p_push_notifications_enabled: safeUpdates.push_notifications_enabled ?? null
    });

    if (!rpcError) {
      // Refresh the full profile from the DB so we keep fields the RPC does not
      // return (and stay in sync with role_version).
      await fetchProfile(user.id, 'PROFILE_UPDATE');
      return rpcData;
    }

    const rpcMissing = /could not find the function|schema cache|does not exist/i.test(rpcError.message || '');
    if (!rpcMissing) throw rpcError;

    // Fallback for an un-migrated DB: write only the allow-listed fields.
    const { data, error } = await supabase
      .from('profiles')
      .update(safeUpdates)
      .eq('id', user.id)
      .select()
      .single();

    if (error) throw error;
    setProfile(data);
    return data;
  };

  const verifyPassword = async (password) => {
    if (!user) return { success: false, error: 'Not authenticated' };
    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, password })
      });
      return await response.json();
    } catch (err) {
      return { success: false, error: 'Connection failed' };
    }
  };

  const requestEmailChange = async (newEmail) => {
    if (!user) return;
    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/request-email-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, oldEmail: user.email, newEmail })
      });
      return await response.json();
    } catch (err) {
      return { success: false, error: 'Request failed' };
    }
  };

  const confirmEmailChange = async (otp) => {
    if (!user) return;
    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/confirm-email-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, otp })
      });
      const result = await response.json();
      if (result.success) {
        await fetchProfile(user.id, 'EMAIL_CHANGE_COMPLETE');
      }
      return result;
    } catch (err) {
      return { success: false, error: 'Confirmation failed' };
    }
  };

  const deactivateAccount = async () => {
    if (!user) return;
    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/deactivate-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id })
      });
      const result = await response.json();
      if (result.success) {
        await signOut();
      }
      return result;
    } catch (err) {
      return { success: false, error: 'Deactivation failed' };
    }
  };

  const recoverAccount = async (userId) => {
    try {
      // 🛡️ SCENARIO 14 — SERVER-AUTHORITATIVE RECOVERY.
      //
      // The previous version wrote `is_active: true` directly to profiles from
      // the browser. That meant a deactivated account could self-reactivate at
      // ANY time — including long past the 15-day grace window — provided RLS
      // allowed the self-write, and the grace deadline was never actually
      // enforced. The `recover_account()` RPC now owns the decision server-side
      // (window-checked, own-account only, audited). We fall back to the legacy
      // direct write ONLY if the RPC is not yet deployed, so an un-migrated DB
      // still works.
      const { data, error } = await supabase.rpc('recover_account');

      if (error) {
        const rpcMissing = /could not find the function|schema cache|does not exist/i.test(error.message || '');
        if (!rpcMissing) {
          // A real rejection (e.g. grace window expired) — surface it, do NOT
          // silently reactivate.
          return { success: false, error: error.message };
        }
        console.warn('[Auth] recover_account RPC unavailable — using legacy direct recovery.');
        const { error: legacyError } = await supabase
          .from('profiles')
          .update({ is_active: true, deactivated_at: null })
          .eq('id', userId);
        if (legacyError) throw legacyError;
      } else if (data && data.recovered === false) {
        return { success: false, error: 'This account is already active.' };
      }

      await fetchProfile(userId, 'ACCOUNT_RECOVERY');
      toast.success('Account successfully recovered!');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const toggleShift = async (newStatus) => {
    if (!profile?.id) {
      toast.error('Your profile is still loading. Please try again in a moment.');
      return { success: false, error: 'Profile not loaded' };
    }
    const toastId = toast.loading(newStatus ? 'Clocking in...' : 'Clocking out...');

    try {
      // 🛡️ REQ-AUTH-09: Use secure backend relay for administrative shift toggle
      // This bypasses RLS restrictions on the profiles table for staff.
      const response = await fetch(`${BACKEND_URL}/api/staff/toggle-shift`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: profile.id, newStatus })
      });

      // Read defensively: a backend that is down, crashed mid-request, or behind a
      // proxy can return an empty or non-JSON body. Parsing that unconditionally
      // previously surfaced as an opaque "Unexpected end of JSON input" instead of
      // a usable message.
      const raw = await response.text();
      let result = {};
      try {
        result = raw ? JSON.parse(raw) : {};
      } catch {
        result = {};
      }

      if (!response.ok || !result.success) {
        throw new Error(result.error || `Shift toggle failed (HTTP ${response.status}).`);
      }

      // Immediately sync local state from the backend's source of truth
      if (result.profile) {
        setProfile(result.profile);
      }

      toast.success(newStatus ? 'Successfully Clocked In!' : 'Successfully Clocked Out!', { id: toastId });

      // Secondary background re-sync to ensure any other profile fields are fresh
      setTimeout(async () => {
        await fetchProfile(profile.id, 'SHIFT_TOGGLE', true);
      }, 500);

      return { success: true };
    } catch (err) {
      logger.error('Shift Toggle Relay Error', err);
      // Prefer the concrete server/client reason; fall back to the relay message.
      const detail = err?.message && err.message !== 'Failed to fetch'
        ? err.message
        : (err?.message === 'Failed to fetch'
            ? 'System relay unreachable — is the backend server running?'
            : 'System relay unavailable.');
      toast.error(newStatus ? `Could not clock in. ${detail}` : `Could not clock out. ${detail}`, { id: toastId });
      return { success: false, error: err.message };
    }
  };

  // 🛡️ SCENARIO 13 — MID-SHIFT ROLE REVOCATION WATCHDOG.
  //
  // A super-admin can demote a STAFF member to CUSTOMER (or revoke access) while
  // that member is mid-shift. The database already denies the next privileged
  // call (is_admin() reads the LIVE role), but the browser keeps a STALE role in
  // memory — so the UI still showed Admin/Staff controls and the user only found
  // out mid-action. This watchdog polls the live access context (cheap SECURITY
  // DEFINER RPC) and, the moment the role changes or the account is deactivated,
  // tears the session down and sends the user to login WITHOUT an error loop.
  useEffect(() => {
    if (!user?.id) return undefined;

    let cancelled = false;
    const cachedRole = String(profile?.role || '').toUpperCase();
    const cachedVersion = Number(profile?.role_version || 1);

    const checkAccess = async () => {
      try {
        const { data, error } = await supabase.rpc('my_access_context');
        if (cancelled || error || !data) return;

        const liveRole = String(data.role || '').toUpperCase();
        const liveVersion = Number(data.role_version || 1);
        const liveActive = data.is_active !== false;

        const roleChanged = cachedRole && liveRole && liveRole !== cachedRole;
        const versionBumped = liveVersion > cachedVersion;
        const deactivated = !liveActive;

        if (deactivated || versionBumped || roleChanged) {
          // Revoked mid-session: boot gracefully. A demoted STAFF becomes a
          // CUSTOMER silently (no error); a deactivated account is signed out.
          toast.error(deactivated
            ? 'Your account access was revoked. Please sign in again.'
            : `Your access level changed to ${liveRole}. Refreshing your session…`);
          if (deactivated) {
            await signOut();
          } else if (typeof window !== 'undefined') {
            window.location.reload();
          }
        }
      } catch {
        // Never surface a watchdog failure — a transient RPC error must not log
        // the user out or spam the console.
      }
    };

    // Check on mount, on focus/visibility (a user returning to a backgrounded
    // tab), and on a slow interval.
    checkAccess();
    const interval = setInterval(checkAccess, 60000);
    const onFocus = () => checkAccess();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [user?.id, profile?.role, profile?.role_version, signOut]);

  return (
    <AuthContext.Provider value={{
      user, profile, loading, isInitialized, signInWithPassword, signOut, resetPassword, requestPasswordReset, changePassword,
      updateProfile, verifyPassword, requestPasswordChange, resendPasswordChange, requestEmailChange, confirmEmailChange, deactivateAccount, recoverAccount, fetchProfile, setProfile,
      toggleShift
    }}>
      {children}
    </AuthContext.Provider>
  );
};
