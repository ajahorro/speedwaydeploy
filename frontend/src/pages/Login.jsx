import React, { useEffect, useState } from 'react';
import { useAuthFlow } from '../hooks/useAuthFlow';
import AuthHeader from '../components/auth/AuthHeader';
import LoginForm from '../components/auth/LoginForm';
import RegisterForm from '../components/auth/RegisterForm';
import RecoverForm from '../components/auth/RecoverForm';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { X, Mail } from 'lucide-react';

const Login = ({ isModal = false, onClose }) => {
  const isMobile = useMediaQuery('(max-width: 640px)');
  const {
    mode,
    setMode,
    isLoading,
    verificationEmail,
    login,
    startRegister,
    resendConfirmation,
    recoverPassword,
    loginError,
    clearLoginError
  } = useAuthFlow();

  // Carried across mode switches so "Forgot Password?" does not make the user
  // retype the address they just entered on the login form.
  const [prefillEmail, setPrefillEmail] = useState('');
  const switchMode = (nextMode, carriedEmail) => {
    // A form that knows the address passes it along; otherwise keep whatever the
    // login form last reported so the prefill survives Register -> Login hops.
    if (carriedEmail) setPrefillEmail(carriedEmail);
    setMode(nextMode);
  };

  // Arriving from a password-reset email (/login?reset=true) lands on the login
  // screen. /password-confirmation is the surface that actually completes a
  // reset, so point the user there rather than at a screen that cannot.
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reset') === 'true') {
      window.location.replace('/password-confirmation');
    }
  }, []);

  const renderForm = () => {
    switch (mode) {
      case 'LOGIN':
        return <LoginForm onLogin={login} onSwitchMode={switchMode} isLoading={isLoading} error={loginError} onClearError={clearLoginError} initialEmail={prefillEmail} onEmailChange={setPrefillEmail} />;
      case 'REGISTER':
        return <RegisterForm onRegister={startRegister} onSwitchMode={switchMode} isLoading={isLoading} initialEmail={prefillEmail} />;
      case 'RECOVER':
        return <RecoverForm onRecover={recoverPassword} onSwitchMode={switchMode} isLoading={isLoading} initialEmail={prefillEmail} />;
      // ACE-16: account activation is link-based, so no 6-digit VERIFY step and
      // no in-page RESET step exist. Password resets are completed on the
      // dedicated /password-confirmation page reached from the email link.
      case 'AWAIT_LINK':
        return (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <div style={{
              width: '64px',
              height: '64px',
              background: 'rgba(169, 27, 24, 0.1)',
              borderRadius: '1.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1.5rem',
              color: 'var(--admin-brand)',
              border: '1px solid rgba(169, 27, 24, 0.2)'
            }}>
              <Mail size={32} />
            </div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: '950', marginBottom: '0.75rem', textTransform: 'uppercase' }}>Check Your Email</h2>
            <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.85rem', lineHeight: '1.6', marginBottom: '2rem' }}>
              We've sent a activation link to <strong style={{ color: 'var(--admin-text-primary)' }}>{verificationEmail}</strong>.
              Please click the link to activate your account.
            </p>
            <button
              onClick={() => switchMode('LOGIN')}
              style={{
                background: 'transparent',
                border: '1px solid var(--admin-border)',
                color: 'var(--admin-text-primary)',
                padding: '0.75rem 1.5rem',
                borderRadius: '0.85rem',
                fontWeight: '900',
                fontSize: '0.8rem',
                cursor: 'pointer',
                textTransform: 'uppercase'
              }}
            >
              Back to Login
            </button>
          </div>
        );
      default:
        return <LoginForm onLogin={login} onSwitchMode={setMode} isLoading={isLoading} />;
    }
  };

  const overlayStyle = isModal ? {
    position: 'fixed',
    top: 0, left: 0, width: '100vw', height: '100vh',
    background: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(10px)',
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    zIndex: 2000, padding: '1rem', overflow: 'hidden'
  } : {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--admin-bg)', padding: '1rem', position: 'relative', overflow: 'hidden',
    // The decorative BlurGlow discs are sized in the hundreds of px and offset
    // negative; clipping them here keeps /login at zero horizontal overflow on
    // 375px without touching their visual effect within the viewport.
    maxWidth: '100vw'
  };

  const cardStyle = {
    width: '100%',
    maxWidth: 'min(92vw, 440px)',
    background: 'var(--admin-card)',
    padding: 'clamp(1.5rem, 5vw, 3rem)',
    borderRadius: '4px', // SHARP EDGES AS REQUESTED
    position: 'relative',
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    border: '1px solid var(--admin-border)',
    color: 'var(--admin-text-primary)',
    animation: 'modalIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
    margin: 'auto'
  };

  const BlurGlow = ({ top, left, right, bottom, size, color }) => (
    <div style={{
      position: 'absolute',
      top, left, right, bottom,
      width: size, height: size,
      background: color || 'rgba(169, 27, 24, 0.2)',
      filter: 'blur(150px)',
      borderRadius: '50%',
      zIndex: 0,
      pointerEvents: 'none',
      opacity: 0.5
    }} />
  );

  return (
    <div style={overlayStyle} onClick={isModal ? onClose : undefined}>
      {/* Background Glows */}
      {!isModal && (
        <>
          <BlurGlow top="-5%" left="-5%" size="800px" color="rgba(169, 27, 24, 0.3)" />
          <BlurGlow top="20%" right="-5%" size="700px" color="rgba(169, 27, 24, 0.2)" />
          <BlurGlow bottom="5%" right="0%" size="800px" color="rgba(169, 27, 24, 0.2)" />
        </>
      )}

      <div style={cardStyle} onClick={e => e.stopPropagation()}>
        {isModal && (
          <button onClick={onClose} style={{ position: 'absolute', top: '1.25rem', right: '1.25rem', background: 'transparent', border: 'none', color: 'var(--admin-text-secondary)', cursor: 'pointer', padding: '0.5rem', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={20} />
          </button>
        )}
        <AuthHeader mode={mode} email={prefillEmail} />
        {renderForm()}
      </div>
      <style>{`
        @keyframes modalIn { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
      `}</style>
    </div>
  );
};

export default Login;
