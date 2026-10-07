import React, { useState } from 'react';
import { Mail } from 'lucide-react';
import StyledInput from './StyledInput';
import { Button } from '@/components/ui/button';
import { sanitizeEmail } from '../../config/constants';

const RecoverForm = ({ onRecover, onSwitchMode, isLoading, initialEmail = '' }) => {
  // Prefilled from the login form so the user never retypes their address.
  const [email, setEmail] = useState(initialEmail || '');

  const handleSubmit = (e) => {
    e.preventDefault();
    onRecover(email.trim());
  };


  return (
    <form onSubmit={handleSubmit}>
      <p style={{ textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem', lineHeight: '1.6', fontWeight: '500', opacity: 0.8 }}>
        Enter your email address to receive a <br />password reset link.
      </p>
      <div style={{ marginBottom: '1.5rem' }}>
        <StyledInput icon={Mail} type="email" placeholder="Email Address" required value={email} onChange={e => setEmail(sanitizeEmail(e.target.value))} autoComplete="email" autoFocus />
      </div>
      <Button type="submit" disabled={isLoading} className="mt-6 h-12 w-full text-sm font-black uppercase tracking-wider">
        {isLoading ? 'Sending...' : 'Send Recovery Link'}
      </Button>
      <p style={{ textAlign: 'center', marginTop: '1.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: '600' }}>
        Remember your password? <Button type="button" variant="link" className="h-auto p-0 font-black text-primary" onClick={() => onSwitchMode('LOGIN')}>Login</Button>
      </p>
    </form>
  );
};

export default RecoverForm;
