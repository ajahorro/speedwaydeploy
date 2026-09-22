import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, ShieldAlert, CheckCircle2, Loader2, LogOut } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';

/**
 * Section 1.1 — <MustChangePasswordGate>
 *
 * Intercepts a session whose profile carries `must_change_password = true`,
 * immediately after authentication, BEFORE any app route is granted. The screen
 * is un-dismissable: there is no close/back affordance, and the only ways out are
 * (a) successfully setting a new password or (b) signing out.
 *
 * The gate reads the flag live from `profile.must_change_password`, which the
 * backend sets for invited accounts (see /api/admin/invite-account). On success it
 * updates the password through Supabase Auth, clears the flag via the
 * complete_first_login_password_change() RPC, and refetches the profile so the
 * surrounding route tree re-renders into the real dashboard.
 *
 * Password policy: minimum 6 characters, no mandatory character types. The user
 * base includes older individuals who struggle with complex combinations, so we
 * deliberately do not force uppercase/lowercase/number/symbol mixes.
 */
const MIN_PASSWORD_LENGTH = 6;

const MustChangePasswordGate = () => {
  const { user, profile, signOut, fetchProfile } = useAuth();
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Escape hatch: a user who reached this screen by mistake can still leave.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const longEnough = newPassword.length >= MIN_PASSWORD_LENGTH;
  const matches = newPassword.length > 0 && newPassword === confirmPassword;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!longEnough) {
      toast.error(`Your new password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
      return;
    }
    if (!matches) {
      toast.error('The two passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      // 1. Update the password in Supabase Auth.
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;

      // 2. Clear the first-login flag via the owner-only RPC.
      const { error: rpcError } = await supabase.rpc('complete_first_login_password_change');
      if (rpcError) throw rpcError;

      // 3. Refresh the profile so the route tree stops rendering the gate.
      if (user?.id) await fetchProfile(user.id, 'FIRST_LOGIN_COMPLETE', true);

      toast.success('Password updated. Welcome to Speedway!');
    } catch (err) {
      toast.error(err.message || 'Could not update your password. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  const cardStyle = {
    width: '100%',
    maxWidth: 'min(92vw, 460px)',
    background: 'var(--admin-card)',
    border: '1px solid var(--admin-border)',
    borderRadius: '4px',
    padding: 'clamp(1.5rem, 5vw, 2.5rem)',
    color: 'var(--admin-text-primary)',
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
  };

  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '1rem 1rem 1rem 2.75rem',
    background: 'var(--admin-bg)',
    border: '1px solid var(--admin-border)',
    borderRadius: '0.85rem',
    color: 'var(--admin-text-primary)',
    fontSize: '0.95rem',
    outline: 'none'
  };

  return (
    <div style={{ minHeight: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--admin-bg)', padding: '1rem', position: 'fixed', inset: 0, zIndex: 5000 }}>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '0.85rem', background: 'rgba(169, 27, 24, 0.12)', border: '1px solid rgba(169, 27, 24, 0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-brand)' }}>
            <ShieldAlert size={24} />
          </div>
          <div>
            <div style={{ fontSize: '0.6rem', fontWeight: '950', letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--admin-brand)' }}>Account Security</div>
            <h1 style={{ margin: 0, fontSize: '1.15rem', fontWeight: '950', textTransform: 'uppercase' }}>Set Your Password</h1>
          </div>
        </div>

        <p style={{ fontSize: '0.82rem', color: 'var(--admin-text-secondary)', lineHeight: 1.6, marginBottom: '1.5rem', fontWeight: '600' }}>
          {profile?.full_name ? `Hi ${profile.full_name.split(' ')[0]}, y` : 'Y'}our account was created with a temporary password.
          For your security you must set a new password before you can continue.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ position: 'relative' }}>
            <Lock size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--admin-text-secondary)' }} />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="New Password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ position: 'relative' }}>
            <Lock size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--admin-text-secondary)' }} />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm New Password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.7rem 1rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '0.85rem', fontSize: '0.72rem', fontWeight: '700', color: longEnough ? '#10b981' : 'var(--admin-text-secondary)' }}>
            <CheckCircle2 size={13} style={{ opacity: longEnough ? 1 : 0.35 }} />
            <span>At least {MIN_PASSWORD_LENGTH} characters</span>
          </div>
          {confirmPassword.length > 0 && !matches && (
            <div style={{ fontSize: '0.72rem', fontWeight: '800', color: '#ef4444' }}>Passwords do not match.</div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            style={{ width: '100%', background: 'var(--admin-brand)', color: '#FFFFFF', padding: '1.05rem', borderRadius: '0.85rem', border: 'none', fontWeight: '900', fontSize: '0.85rem', cursor: isSubmitting ? 'not-allowed' : 'pointer', textTransform: 'uppercase', letterSpacing: '1px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginTop: '0.5rem', opacity: isSubmitting ? 0.7 : 1 }}
          >
            {isSubmitting ? <><Loader2 size={16} className="animate-spin" /> Updating...</> : 'Set Password & Continue'}
          </button>

          <button
            type="button"
            onClick={handleSignOut}
            style={{ background: 'transparent', border: 'none', color: 'var(--admin-text-secondary)', fontWeight: '700', fontSize: '0.78rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
          >
            <LogOut size={14} /> Sign out instead
          </button>
        </form>
      </div>
      <style>{`.animate-spin { animation: fcspin 1s linear infinite; } @keyframes fcspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

export default MustChangePasswordGate;
