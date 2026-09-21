import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

export const useAuthFlow = () => {
  const navigate = useNavigate();
  const { user, profile, signInWithPassword, requestPasswordReset } = useAuth();
  
  const [mode, setMode] = useState('LOGIN'); // LOGIN, REGISTER, VERIFY, AWAIT_LINK, RECOVER, RECOVER_VERIFY, RESET
  const [isLoading, setIsLoading] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState('');
  const [loginError, setLoginError] = useState('');

  // Auto-redirect whenever session and profile are both available
  useEffect(() => {
    if (user && profile) {
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
        navigate(routes[profile.role] || '/customer');
      }
    }
  }, [user, profile, mode, navigate]);

  const login = async (email, password) => {
    setIsLoading(true);
    setLoginError('');
    try {
      const { error } = await signInWithPassword(email, password);
      if (error) throw error;
      
      toast.success('Successfully logged in!', {
        style: { background: 'var(--admin-card)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', backdropFilter: 'blur(12px)' }
      });
    } catch (error) {
      setLoginError(error.message || 'Login failed.');
      toast.error(error.message || 'Login failed.', {
        style: { background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.2)', backdropFilter: 'blur(12px)' }
      });
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
          emailRedirectTo: `${window.location.origin}/login`
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

      toast.success('Registration successful! Check your inbox to activate your account.', {
        style: { background: 'var(--admin-card)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', backdropFilter: 'blur(12px)' }
      });

      setMode('AWAIT_LINK');
    } catch (error) {
      toast.error(error.message || 'Registration failed.', {
        style: { background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.2)', backdropFilter: 'blur(12px)' }
      });
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
      toast.success(`Activation link resent to ${target}.`, {
        style: { background: 'var(--admin-card)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', backdropFilter: 'blur(12px)' }
      });
    } catch (error) {
      toast.error(error.message || 'Could not resend the activation link.', {
        style: { background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.2)', backdropFilter: 'blur(12px)' }
      });
    } finally {
      setIsLoading(false);
    }
  };

  const recoverPassword = async (email) => {
    setIsLoading(true);
    try {
      // Route through backend relay for branded Resend delivery
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
      const res = await fetch(`${BACKEND_URL}/api/auth/recover-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Recovery request failed');


      setVerificationEmail(email);
      toast.success('If an account is associated with that email, a password reset link has been sent.', {
        style: { background: 'var(--admin-card)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', backdropFilter: 'blur(12px)' }
      });
      setMode('LOGIN');
    } catch (error) {
      toast.error(error.message, {
        style: { background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.2)', backdropFilter: 'blur(12px)' }
      });
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
    loginError,
    clearLoginError: () => setLoginError(''),
  };
};
