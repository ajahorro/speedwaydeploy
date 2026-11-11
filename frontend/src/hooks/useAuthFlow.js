import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import toast from '@/lib/toast';
import { BACKEND_URL } from '../config/api';
import { emailError, phoneError, normalizePhPhone } from '../utils/contactValidation';
import { safeNextPath } from '../utils/safeNextPath';
import { BREACHED_PASSWORD_ERROR, isBreachedPassword } from '../utils/breachedPassword';
import { onHandOff } from '@/lib/tabHandoff';

/**
 * @param {{ next?: string }} [options] next: where to go after sign-in when the page address has no ?next=
 *   (the sign-in pop-up passes it, e.g. /customer/book after a "Book" button). Checked by safeNextPath like ?next=.
 */
const STAFF_ROLES = ['ADMIN', 'SUPER_ADMIN', 'STAFF'];

/** audience: 'customer' (/login) or 'staff' (/staff/login). An account signing in on the other page is signed out. */
export const useAuthFlow = ({ next: nextOption, audience } = {}) => {
  const navigate = useNavigate();
  const { user, profile, signInWithPassword, requestPasswordReset, signOut } = useAuth();
  const attemptedRef = useRef(false);
  const [wrongPage, setWrongPage] = useState(null); // 'staff' | 'customer': the page this account belongs on

  const [mode, setMode] = useState('LOGIN'); // LOGIN, REGISTER, VERIFY, AWAIT_LINK, RECOVER, RECOVER_OTP, RECOVER_VERIFY, RESET
  const [isLoading, setIsLoading] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState('');
  const [loginError, setLoginError] = useState('');

  // Auto-redirect whenever session and profile are both available
  useEffect(() => {
    if (user && profile) {
      const roleKey = String(profile.role || '').toUpperCase();
      const belongsOn = STAFF_ROLES.includes(roleKey) ? 'staff' : 'customer';
      if (attemptedRef.current && audience && audience !== belongsOn) {
        attemptedRef.current = false;
        setWrongPage(belongsOn);
        setLoginError(belongsOn === 'staff'
          ? 'This is the customer sign-in. Staff and administrator accounts sign in on the staff page.'
          : 'This sign-in is for shop staff. Customers sign in on the customer page.');
        signOut();
        return;
      }
      const routes = {
        ADMIN: '/admin',
        STAFF: '/staff',
        CUSTOMER: '/customer'
      };
      // Stay put during a password reset AND during account activation. When the
      // confirmation link is followed, Supabase creates a session; without this
      // guard the user was bounced straight into the dashboard and never saw the
      // "check your email" screen.
      if (mode !== 'RESET' && mode !== 'AWAIT_LINK') {
        // An email button or a guarded page sends people here with ?next=<page>;
        // after sign-in they continue to it (when it is theirs to open).
        const next = safeNextPath(new URLSearchParams(window.location.search).get('next') || nextOption, roleKey);
        navigate(next || routes[roleKey] || '/customer');
      }
    }
  }, [user, profile, mode, navigate, nextOption, audience, signOut]);

  // another tab finished the emailed step: an activated account is signed in (the redirect above takes over),
  // a new password means signing in with it here
  useEffect(() => onHandOff((kind) => {
    if (kind === 'account-confirmed') window.location.reload();
    if (kind === 'password-updated') { setMode('LOGIN'); toast.success('Password updated. Sign in with your new password.'); }
  }), []);

  const login = async (email, password) => {
    setIsLoading(true);
    setLoginError('');
    setWrongPage(null);
    attemptedRef.current = true;
    try {
      const { error } = await signInWithPassword(email, password);
      if (error) throw error;
      // no success toast here: the account may still be on the wrong page (see the redirect above)
    } catch (error) {
      setLoginError(error.message || 'Login failed.');
      toast.error(error.message || 'Login failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const startRegister = async (userData) => {
    setIsLoading(true);
    try {
      const email = userData.email.trim().toLowerCase();
      const contactProblem = emailError(email) || phoneError(userData.phone);
      if (contactProblem) throw new Error(contactProblem);
      if (userData.password.length < 6) {
        throw new Error('Password must be at least 6 characters long.');
      }
      if (!userData.firstName.trim() || !userData.lastName.trim()) {
        throw new Error('First and last name are required.');
      }


      // From a walk-in's invite link: the server makes the account already confirmed, then we sign straight in.
      if (userData.inviteToken) {
        const res = await fetch(`${BACKEND_URL}/customer/register-invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: userData.inviteToken, first_name: userData.firstName.trim(), last_name: userData.lastName.trim(), phone: normalizePhPhone(userData.phone), password: userData.password })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Registration failed.');
        const { error: signInError } = await signInWithPassword(email, userData.password);
        if (signInError) throw signInError;
        await supabase.rpc('accept_current_policies'); // agreed on the form; a failure only means TermsGate asks again
        toast.success('Your account is ready. Welcome!');
        return;
      }

      if (await isBreachedPassword(userData.password)) throw new Error(BREACHED_PASSWORD_ERROR);
      // The server creates the account and sends the confirmation link from the same sender as every other email.
      const res = await fetch(`${BACKEND_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: userData.password,
          first_name: userData.firstName.trim(),
          last_name: userData.lastName.trim(),
          phone: normalizePhPhone(userData.phone),
          // agreed on the form; recorded on the first sign-in
          accepted_terms_version: userData.acceptedTerms,
          accepted_security_version: userData.acceptedPrivacy
        })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && !body.accountCreated) throw new Error(body.error || 'Registration failed.');
      if (body.accountCreated) toast.error(body.error);

      setVerificationEmail(email);

      toast.success('Registration successful! Check your inbox to activate your account.');

      setMode('AWAIT_LINK');
    } catch (error) {
      toast.error(error.message || 'Registration failed.');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * ACE-16: account activation is link-based, so a 6-digit code is not required.
   * Routing registration here previously re-submitted the whole sign-up form —
   * firing a second confirmation email — instead of resending. From the
   * VERIFY screen we now re-dispatch the signup confirmation.
   */
  const resendConfirmation = async () => {
    const target = (verificationEmail || '').trim();
    if (!target) {
      toast.error('Enter your email address to resend the activation link.');
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/resend-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target.toLowerCase() })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not resend the activation link.');
      toast.success(`Activation link resent to ${target}.`);
    } catch (error) {
      toast.error(error.message || 'Could not resend the activation link.');
    } finally {
      setIsLoading(false);
    }
  };

  const recoverPassword = async (email) => {
    setIsLoading(true);
    try {
      // Route through backend relay for branded Resend delivery
      const res = await fetch(`${BACKEND_URL}/api/auth/recover-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Recovery request failed');


      setVerificationEmail(email);
      toast.success('If an account is associated with that email, a password reset link has been sent.');
      setMode('LOGIN');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Section 1.2 — Emergency Account Recovery.
   *
   * Two-step, email-OTP flow for a user whose account is DB-locked after five
   * failed attempts. requestEmergencyRecovery() emails a single-use 6-digit code;
   * completeEmergencyRecovery() verifies it AND sets the new password in one call.
   * On success the backend clears the DB lock and the first-login flag, so the
   * caller just returns to the login screen. Messages are deliberately neutral on
   * the request step so the flow cannot be used to enumerate accounts.
   */
  const requestEmergencyRecovery = async (email) => {
    const target = (email || '').trim().toLowerCase();
    if (!target) {
      toast.error('Enter the email address on the locked account.');
      return false;
    }
    setIsLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/emergency-recovery/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target })
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Recovery request failed');
      setVerificationEmail(target);
      toast.success('If an account is associated with that email, a recovery code has been sent.');
      setMode('RECOVER_OTP');
      return true;
    } catch (error) {
      toast.error(error.message || 'Could not start account recovery.');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const completeEmergencyRecovery = async (otp, newPassword) => {
    const target = (verificationEmail || '').trim().toLowerCase();
    if (!target) {
      toast.error('Your recovery session expired. Please start again.');
      return false;
    }
    if (!/^\d{6}$/.test(String(otp || ''))) {
      toast.error('Enter the 6-digit recovery code from your email.');
      return false;
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      toast.error('Your new password must be at least 6 characters long.');
      return false;
    }
    setIsLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/emergency-recovery/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target, otp: String(otp), newPassword })
      });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.error || 'Recovery failed');
      toast.success('Account recovered! You can now sign in with your new password.');
      setMode('LOGIN');
      return true;
    } catch (error) {
      toast.error(error.message || 'Unable to complete account recovery.');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    mode,
    setMode,
    isLoading,
    verificationEmail,
    login,
    startRegister,
    resendConfirmation,
    recoverPassword,
    requestEmergencyRecovery,
    completeEmergencyRecovery,
    loginError,
    wrongPage,
    clearLoginError: () => setLoginError(''),
  };
};
