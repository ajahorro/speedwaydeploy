import React, { useState } from 'react';
import { Mail, Lock, KeyRound, ShieldQuestion, ArrowLeft } from 'lucide-react';
import StyledInput from './StyledInput';
import { sanitizeEmail } from '../../config/constants';

/**
 * Section 1.2 — Emergency Account Recovery (email OTP).
 *
 * Two-step form presented from the login screen when a user is locked out:
 *   Step 1 — enter the account email; the backend emails a single-use 6-digit code.
 *   Step 2 — enter the code + a new password; the backend verifies the code,
 *            clears the DB lock, and applies the new password in one call.
 */
const EmergencyRecoveryForm = ({ onRequest, onComplete, onSwitchMode, isLoading, initialEmail = '' }) => {
  const [step, setStep] = useState('REQUEST'); // REQUEST | VERIFY
  const [email, setEmail] = useState(initialEmail || '');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState('');

  const handleRequest = async (e) => {
    e.preventDefault();
    setLocalError('');
    const started = await onRequest(email.trim().toLowerCase());
    if (started) setStep('VERIFY');
  };

  const handleComplete = async (e) => {
    e.preventDefault();
    setLocalError('');
    if (!/^\d{6}$/.test(otp.trim())) {
      setLocalError('Enter the 6-digit recovery code from your email.');
      return;
    }
    if (newPassword.length < 6) {
      setLocalError('Your new password must be at least 6 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError('The two passwords do not match.');
      return;
    }
    await onComplete(otp.trim(), newPassword);
  };

  const buttonStyle = {
    width: '100%',
    background: 'var(--admin-brand)',
    color: '#FFFFFF',
    padding: '1.1rem',
    borderRadius: '0.85rem',
    border: 'none',
    fontWeight: '900',
    fontSize: '0.95rem',
    cursor: 'pointer',
    marginTop: '1.5rem',
    transition: 'all 0.2s ease',
    boxShadow: '0 8px 25px rgba(169, 27, 24, 0.25)',
    textTransform: 'uppercase',
    letterSpacing: '1px'
  };

  const errorBox = localError && (
    <div role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '1rem', padding: '0.75rem', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: '0.65rem', color: '#fca5a5', fontSize: '0.8rem', fontWeight: '700', lineHeight: 1.4 }}>
      <ShieldQuestion size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
      <span>{localError}</span>
    </div>
  );

  if (step === 'REQUEST') {
    return (
      <form onSubmit={handleRequest}>
        <p style={{ textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem', lineHeight: 1.6, fontWeight: '500', opacity: 0.9 }}>
          Account locked after too many attempts?<br />Enter your email to unlock it and set a new password.
        </p>
        {errorBox}
        <div style={{ marginBottom: '1.5rem' }}>
          <StyledInput icon={Mail} type="email" placeholder="Email Address" required value={email} onChange={e => setEmail(sanitizeEmail(e.target.value))} autoComplete="email" autoFocus />
        </div>
        <button type="submit" disabled={isLoading} style={buttonStyle}>
          {isLoading ? 'Sending Code...' : 'Send Recovery Code'}
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center', marginTop: '1.5rem', fontSize: '0.85rem' }}>
          <span onClick={() => onSwitchMode('LOGIN')} style={{ color: 'var(--admin-text-secondary)', cursor: 'pointer', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <ArrowLeft size={14} /> Back to Login
          </span>
          <span onClick={() => onSwitchMode('RECOVER')} style={{ color: 'var(--admin-text-secondary)', cursor: 'pointer', fontWeight: '700', opacity: 0.6 }}>
            Just forgot your password?
          </span>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleComplete}>
      <p style={{ textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem', lineHeight: 1.6, fontWeight: '500', opacity: 0.9 }}>
        We sent a recovery code to <strong style={{ color: 'var(--admin-text-primary)' }}>{email}</strong>.<br />
        Enter it below with your new password.
      </p>
      {errorBox}
      <div style={{ marginBottom: '1.25rem' }}>
        <StyledInput icon={KeyRound} type="text" placeholder="6-digit Code" required value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="one-time-code" autoFocus />
      </div>
      <div style={{ marginBottom: '1.25rem' }}>
        <StyledInput icon={Lock} type="password" placeholder="New Password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" />
      </div>
      <div style={{ marginBottom: '1.25rem' }}>
        <StyledInput icon={Lock} type="password" placeholder="Confirm New Password" required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" />
      </div>
      <button type="submit" disabled={isLoading} style={buttonStyle}>
        {isLoading ? 'Recovering...' : 'Unlock & Set Password'}
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center', marginTop: '1.5rem', fontSize: '0.85rem' }}>
        <span onClick={() => setStep('REQUEST')} style={{ color: 'var(--admin-text-secondary)', cursor: 'pointer', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <ArrowLeft size={14} /> Use a different email
        </span>
        <span onClick={() => onSwitchMode('LOGIN')} style={{ color: 'var(--admin-text-secondary)', cursor: 'pointer', fontWeight: '700', opacity: 0.6 }}>
          Back to Login
        </span>
      </div>
    </form>
  );
};

export default EmergencyRecoveryForm;
