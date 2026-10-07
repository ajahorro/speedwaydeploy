import React, { useState } from 'react';
import { Mail, Lock, AlertCircle } from 'lucide-react';
import StyledInput from './StyledInput';
import { Button } from '@/components/ui/button';
import { sanitizeEmail } from '../../config/constants';

const LoginForm = ({ onLogin, onSwitchMode, isLoading, error, onClearError, initialEmail = '', onEmailChange }) => {
  const [email, setEmail] = useState(initialEmail || '');
  const [password, setPassword] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onLogin(email.trim(), password);
  };


  return (
    <form onSubmit={handleSubmit}>
      <div style={{ marginBottom: '1.25rem' }}>
        {error && (
          <div role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '1rem', padding: '0.75rem', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: '0.65rem', color: '#fca5a5', fontSize: '0.8rem', fontWeight: '700', lineHeight: 1.4 }}>
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}
        <StyledInput icon={Mail} type="email" placeholder="Email Address" required value={email} onChange={e => { const v = sanitizeEmail(e.target.value); setEmail(v); onEmailChange?.(v); onClearError?.(); }} autoComplete="email" />
      </div>
      <div style={{ position: 'relative', marginBottom: '1.25rem' }}>
        <StyledInput icon={Lock} type="password" placeholder="Password" required value={password} onChange={e => { setPassword(e.target.value); onClearError?.(); }} autoComplete="current-password" />
      </div>
      <Button type="submit" disabled={isLoading} className="mt-6 h-12 w-full text-sm font-black uppercase tracking-wider">
        {isLoading ? 'Processing...' : 'Login'}
      </Button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center', marginTop: '1.5rem', fontSize: '0.85rem' }}>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontWeight: '600' }}>
          Don't have an account? <Button type="button" variant="link" className="h-auto p-0 font-black text-primary" onClick={() => onSwitchMode('REGISTER')}>Register</Button>
        </p>
        <Button type="button" variant="link" className="h-auto p-0 font-bold text-muted-foreground" onClick={() => onSwitchMode('RECOVER', email)}>Forgot Password?</Button>
        {/* Section 1.2: reach the email-OTP unlock flow without waiting out the lock. */}
        <Button type="button" variant="link" className="h-auto p-0 font-bold text-muted-foreground" onClick={() => onSwitchMode('RECOVER_OTP', email)}>Account locked? Recover it</Button>
      </div>
    </form>
  );
};

export default LoginForm;
