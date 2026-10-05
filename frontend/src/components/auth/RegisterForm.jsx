import React, { useState } from 'react';
import { Mail, Lock, User, Phone, Loader2, AlertCircle } from 'lucide-react';
import StyledInput from './StyledInput';
import { sanitizeByFieldType } from '../../config/constants';
import { PhoneInput, EmailInput } from '../common/ContactInputs';
import { emailError, phoneError } from '../../utils/contactValidation';

// Task 2.5: per-field allowlist so each input keeps only its legitimate chars.
const FIELD_TYPE = { firstName: 'text', lastName: 'text', email: 'email', phone: 'phone' };

const RegisterForm = ({ onRegister, onSwitchMode, isLoading, initialEmail = '', initialData = null }) => {
  // A walk-in's invite locks the email address only; name and phone can be corrected.
  const lockEmail = Boolean(initialData?.email);
  const [formData, setFormData] = useState({
    firstName: sanitizeByFieldType(initialData?.firstName || '', FIELD_TYPE.firstName),
    lastName: sanitizeByFieldType(initialData?.lastName || '', FIELD_TYPE.lastName),
    email: sanitizeByFieldType(initialData?.email || initialEmail || '', FIELD_TYPE.email),
    phone: sanitizeByFieldType(initialData?.phone || '', FIELD_TYPE.phone),
    password: '',
    confirmPassword: ''
  });
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    const contactProblem = emailError(formData.email) || phoneError(formData.phone);
    if (contactProblem) {
      setError(contactProblem);
      return;
    }
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setError('');
    onRegister(formData);
  };

  const updateField = (field, value) => {
    // Email / names / phone use their context-aware allowlist; passwords are
    // left untouched (they may legitimately contain any character).
    if (FIELD_TYPE[field]) value = sanitizeByFieldType(value, FIELD_TYPE[field]);
    setFormData(prev => ({ ...prev, [field]: value }));
    if (error) setError('');
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
    marginTop: '1rem',
    transition: 'all 0.2s ease',
    boxShadow: '0 8px 25px rgba(169, 27, 24, 0.25)',
    textTransform: 'uppercase',
    letterSpacing: '1px'
  };

  return (
    <form onSubmit={handleSubmit}>
      {error && (
        <div role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '1rem', padding: '0.75rem', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: '0.65rem', color: '#fca5a5', fontSize: '0.8rem', fontWeight: '700' }}>
          <AlertCircle size={16} style={{ flexShrink: 0 }} /> {error}
        </div>
      )}
      {lockEmail && (
        <p style={{ margin: '0 0 1rem', color: 'var(--admin-text-secondary)', fontSize: '0.78rem', lineHeight: 1.5 }}>
          We filled in the details from your booking. You can correct your name and phone number; your email address is fixed so the booking links to your account. Set a password to finish.
        </p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
        <div style={{ position: 'relative' }}>
          <StyledInput icon={User} type="text" placeholder="First Name" required value={formData.firstName} onChange={e => updateField('firstName', e.target.value)} autoComplete="given-name" readOnly={false} />
        </div>
        <div style={{ position: 'relative' }}>
          <StyledInput icon={User} type="text" placeholder="Last Name" required value={formData.lastName} onChange={e => updateField('lastName', e.target.value)} autoComplete="family-name" readOnly={false} />
        </div>
      </div>

      <div style={{ position: 'relative', marginBottom: '1rem' }}>
        <EmailInput as={StyledInput} icon={Mail} placeholder="Email Address" value={formData.email} onChange={e => updateField('email', e.target.value)} readOnly={lockEmail} />
      </div>
      
      <div style={{ position: 'relative', marginBottom: '1rem' }}>
        <PhoneInput as={StyledInput} icon={Phone} placeholder="Mobile number (09123456789)" value={formData.phone} onChange={e => updateField('phone', e.target.value)} readOnly={false} />
      </div>

      <div style={{ position: 'relative', marginBottom: '1.5rem' }}>
        <StyledInput icon={Lock} type="password" placeholder="Create Password" required value={formData.password} onChange={e => updateField('password', e.target.value)} autoComplete="new-password" />
      </div>

      <div style={{ position: 'relative', marginBottom: '1.5rem' }}>
        <StyledInput icon={Lock} type="password" placeholder="Confirm Password" required value={formData.confirmPassword} onChange={e => updateField('confirmPassword', e.target.value)} autoComplete="new-password" />
      </div>

      <button type="submit" disabled={isLoading} style={buttonStyle}>
        {isLoading ? <><Loader2 size={16} style={{ verticalAlign: 'middle', marginRight: '0.4rem', animation: 'spin 1s linear infinite' }} /> Creating Account...</> : 'Register'}
      </button>
      
      <p style={{ textAlign: 'center', marginTop: '1.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: '600' }}>
        Already have an account? <span onClick={() => onSwitchMode('LOGIN')} style={{ color: 'var(--admin-brand)', cursor: 'pointer', fontWeight: '900' }}>Login</span>
      </p>
    </form>
  );
};

export default RegisterForm;
