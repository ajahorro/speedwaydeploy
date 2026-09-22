import React from 'react';

const AuthHeader = ({ mode, email }) => {
  // Copy states what the screen actually does. "RESET YOUR PASSWORD" over an
  // email-entry form promised an outcome the screen cannot deliver — the reset
  // itself happens from the emailed link, on /password-confirmation.
  const getSubtext = () => {
    switch (mode) {
      case 'LOGIN': return 'WELCOME BACK';
      case 'REGISTER': return 'CREATE YOUR ACCOUNT';
      case 'RECOVER': return 'REQUEST A RESET LINK';
      case 'RECOVER_OTP': return 'EMERGENCY ACCOUNT RECOVERY';
      case 'VERIFY':
      case 'RECOVER_VERIFY': return 'VERIFY YOUR ACCOUNT';
      case 'AWAIT_LINK': return 'CHECK YOUR EMAIL';
      case 'RESET': return 'SET NEW PASSWORD';
      default: return 'WELCOME';
    }
  };

  return (
    <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
      <h1 style={{
        margin: 0,
        fontSize: '1.25rem',
        fontWeight: '950',
        color: 'var(--admin-text-primary)',
        letterSpacing: '1.5px',
        textTransform: 'uppercase',
        lineHeight: '1.2'
      }}>
        SpeedWay Detail Studio
      </h1>
      <p style={{
        color: 'var(--admin-text-secondary)',
        opacity: 0.6,
        marginTop: '0.6rem',
        fontSize: '0.85rem',
        fontWeight: '600'
      }}>
        {getSubtext()}
      </p>
      {mode === 'LOGIN' && email && (
        <p style={{ color: 'var(--admin-text-secondary)', opacity: 0.75, marginTop: '0.35rem', fontSize: '0.78rem', fontWeight: '700' }}>
          Signing in as {email}
        </p>
      )}
    </div>
  );
};

export default AuthHeader;
