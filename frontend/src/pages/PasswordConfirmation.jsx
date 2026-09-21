import React, { useEffect, useState } from 'react';
import { Lock, ShieldCheck, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

const PasswordConfirmation = () => {
  const token = new URLSearchParams(window.location.search).get('token');
  const [purpose, setPurpose] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState('checking');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      return;
    }
    fetch(`${BACKEND_URL}/api/auth/inspect-password-confirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    })
      .then(response => response.json().then(result => ({ response, result })))
      .then(({ response, result }) => {
        if (!response.ok || !result.success) throw new Error(result.error || 'This link is invalid.');
        setPurpose(result.purpose);
        if (result.purpose === 'UPDATE') {
          return fetch(`${BACKEND_URL}/api/auth/confirm-password-change`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          }).then(response => response.json().then(confirmResult => ({ response, confirmResult })));
        }
        setStatus('ready');
        return null;
      })
      .then(result => {
        if (!result) return;
        if (!result.response.ok || !result.confirmResult.success) throw new Error(result.confirmResult.error || 'Unable to confirm password change.');
        setStatus('complete');
      })
      .catch(error => {
        setStatus('invalid');
        toast.error(error.message);
      });
  }, [token]);

  const submitReset = async (event) => {
    event.preventDefault();
    if (newPassword.length < 6) return toast.error('Password must be at least 6 characters long.');
    if (newPassword !== confirmPassword) return toast.error('Passwords do not match.');
    setIsSubmitting(true);
    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/confirm-password-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword })
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to reset password.');
      setStatus('complete');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const goToLogin = () => { window.location.href = '/login'; };

  // Retry the reset without re-requesting a link. This only serves purpose
  // 'RESET': an 'UPDATE' link consumes itself server-side on first use, so the
  // only recovery there is a fresh request.
  const requestNewLink = async () => {
    window.location.href = '/login';
  };

  const heading = status === 'invalid' ? 'Link Expired or Invalid' : status === 'complete' ? 'Password Updated' : purpose === 'UPDATE' ? 'Password Change Confirmed' : 'Create New Password';

  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'var(--bg-primary)' }}>
    <div style={{ width: '100%', maxWidth: '440px', padding: '2.5rem', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '6px', color: 'var(--admin-text-primary)', textAlign: 'center' }}>
      <div style={{ width: '56px', height: '56px', margin: '0 auto 1.25rem', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: status === 'invalid' ? 'rgba(239,68,68,.12)' : 'rgba(16,185,129,.12)', color: status === 'invalid' ? '#ef4444' : '#10b981' }}>
        {status === 'invalid' ? <AlertTriangle size={28} /> : status === 'complete' ? <ShieldCheck size={28} /> : <Lock size={28} />}
      </div>
      <h1 style={{ margin: '0 0 .75rem', fontSize: '1.4rem', fontWeight: 900 }}>{heading}</h1>
      {status === 'checking' && <p style={{ color: 'var(--admin-text-secondary)' }}>Validating your secure confirmation link...</p>}
      {status === 'invalid' && <><p style={{ color: 'var(--admin-text-secondary)', lineHeight: 1.6 }}>This link has expired, was already used, or is invalid. Request a fresh one from the login screen — use <strong>Forgot Password?</strong>.</p><button onClick={requestNewLink} style={{ marginTop: '1rem', padding: '.75rem 1.25rem', background: 'var(--admin-brand)', color: '#fff', border: 0, borderRadius: '4px', fontWeight: 800, cursor: 'pointer' }}>Request a New Link</button></>}
      {status === 'complete' && <><p style={{ color: 'var(--admin-text-secondary)', lineHeight: 1.6 }}>Your password has been updated successfully. You may now sign in with it.</p><button onClick={goToLogin} style={{ marginTop: '1rem', padding: '.75rem 1.25rem', background: 'var(--admin-brand)', color: '#fff', border: 0, borderRadius: '4px', fontWeight: 800, cursor: 'pointer' }}>Continue to Login</button></>}
      {status === 'ready' && purpose === 'RESET' && <form onSubmit={submitReset} style={{ textAlign: 'left' }}><label style={{ display: 'block', marginBottom: '.4rem', fontWeight: 700 }}>New Password</label><input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} required style={{ width: '100%', boxSizing: 'border-box', padding: '.8rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', borderRadius: '4px' }} /><label style={{ display: 'block', margin: '1rem 0 .4rem', fontWeight: 700 }}>Confirm New Password</label><input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required style={{ width: '100%', boxSizing: 'border-box', padding: '.8rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', borderRadius: '4px' }} /><button disabled={isSubmitting} style={{ width: '100%', marginTop: '1.25rem', padding: '.85rem', background: 'var(--admin-brand)', color: '#fff', border: 0, borderRadius: '4px', fontWeight: 800, cursor: isSubmitting ? 'not-allowed' : 'pointer' }}>{isSubmitting ? 'Updating...' : 'Update Password'}</button></form>}
    </div>
  </div>;
};

export default PasswordConfirmation;
