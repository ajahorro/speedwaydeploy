import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

export const useAuthFlow = () => {
  const navigate = useNavigate();
  const { user, profile, signInWithPassword, requestPasswordReset } = useAuth();
  
  const [mode, setMode] = useState('LOGIN'); // LOGIN, REGISTER, VERIFY, AWAIT_LINK, RECOVER, RECOVER_OTP, RECOVER_VERIFY, RESET
  const [isLoading, setIsLoading] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState('');
  const [loginError, setLoginError] = useState('');

  // Auto-redirect whenever session and profile are both available
  useEffect(() => {
    if (user && profile) {
      const roleKey = String(profile.role || '').toUpperCase();
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
        navigate(routes[roleKey] || '/customer');
      }
    }
  }, [user, profile, mode, navigate]);

  const login = async (email, password) => {    setIsLoading(true);
    setLoginError('');
    try {
      const { error } = await signInWithPassword(email, password);
      if (error) throw error;

      toast.success('Successfully logged in!');
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
      const fullName = `${userData.firstName.trim()} ${userData.lastName.trim()}`.trim();
      if (userData.password.length < 6) {
        throw new Error('Password must be at least 6 characters long.');
      }
      if (!userData.firstName.trim() || !userData.lastName.trim()) {
        throw new Error('First and last name are required.');
      }

      // Email confirmation is mandatory, so a successful signUp() returns NO
      // session. The profile row below therefore cannot be written from the
      // client — RLS would reject it (auth.uid() is null) and the crash surfaced
      // as "Registration failed". The backend writes the profile on confirm
      // instead, which is why this now only validates and reports success.
      // AUTH REDIRECT.
      //
      // This used to be `${window.location.origin}/login`. Supabase appends the
      // session as a URL FRAGMENT (#access_token=...&type=signup), and /login
      // never read a fragment — so a freshly confirmed customer landed on a
      // login FORM with their session silently discarded. That is the
      // "confirmation links don't lead where they are intended" defect.
      //
      // `/auth/callback` consumes the fragment, establishes the session, and
      // redirects by role. The origin is still derived from the browser so it
      // follows whatever domain the app is served from — but the PATH is now a
      // route that actually handles the link.
      //
      // IMPORTANT: this URL must also be listed under Supabase > Authentication >
      // URL Configuration > Redirect URLs, or Supabase ignores it and falls back
      // to the project's Site URL.
      const redirectTo = `${window.location.origin}/auth/callback`;

      const { data, error } = await supabase.auth.signUp({
        email,
        password: userData.password,
        options: {
          // Consumed by the backend when it materialises the profile on confirm.
          data: {
            full_name: fullName,
            first_name: userData.firstName.trim(),
            last_name: userData.lastName.trim(),
            phone_number: userData.phone.trim(),
            role: 'CUSTOMER'
          },
          emailRedirectTo: redirectTo
        }
      });
      if (error) throw error;

      // Supabase deliberately returns a fake user with no identities when the
      // address is already registered, to avoid account enumeration. Treat it as
      // "nothing sent" rather than showing a success screen that never arrives.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new Error('An account with this email already exists. Try signing in or use "Forgot Password?".');
      }

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
      const { error } = await supabase.auth.resend({ type: 'signup', email: target.toLowerCase() });
      if (error) throw error;
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
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || window.location.origin;
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
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || window.location.origin;
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
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || window.location.origin;
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
    clearLoginError: () => setLoginError(''),
  };
};
