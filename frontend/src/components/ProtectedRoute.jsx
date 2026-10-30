import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { logger } from '../utils/logger';
import MustChangePasswordGate from './auth/MustChangePasswordGate';

/** Full-screen skeleton shown while auth / profile resolves. */
const AuthLoadingScreen = ({ message }) => (
  <div style={{
    height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    background: 'var(--admin-bg)', gap: '1rem',
  }}>
    <div style={{
      width: '44px', height: '44px',
      border: '3px solid var(--admin-border)',
      borderTopColor: 'var(--admin-brand)',
      borderRadius: '50%',
      animation: 'authSpin 0.9s linear infinite',
    }} />
    <span style={{
      color: 'var(--admin-text-secondary)',
      fontWeight: '800',
      fontSize: '0.72rem',
      letterSpacing: '1.5px',
      textTransform: 'uppercase',
    }}>{message}</span>
    <style>{'@keyframes authSpin { to { transform: rotate(360deg); } }'}</style>
  </div>
);

const ProtectedRoute = ({ children, allowedRoles = [] }) => {
  const { user, profile, isInitialized, loading } = useAuth();
  const location = useLocation();

  // 1. Session Gate: Only block UI while we're unsure if a session exists
  if (!isInitialized) {
    return <AuthLoadingScreen message="Authenticating..." />;
  }

  // 2. Authentication Check: No session? Straight to Login.
  if (!user) {
    // Remember the page they wanted: sign-in continues there.
    const wanted = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(wanted)}`} replace />;
  }

  // 3. Optional Profile Enrichment Gate:
  // If a route specifically requires a role check, we only wait if we don't have the profile yet.
  if (allowedRoles.length > 0 && !profile) {
    return <AuthLoadingScreen message="Synchronizing permissions..." />;
  }

  // 3b. Section 1.1 — First-login password reset interception.
  // Invited accounts carry must_change_password = true; the un-dismissable gate
  // renders here, before ANY role check or app route is granted. Escape is
  // impossible except by setting a password or signing out.
  if (profile?.must_change_password === true) {
    return <MustChangePasswordGate />;
  }

  // 4. RBAC Check (if profile exists)
  if (allowedRoles.length > 0 && profile) {
    const hasRole = allowedRoles.includes(profile.role?.toUpperCase());
    if (!hasRole) {
      logger.warn(`Access Denied: '${profile.role}' lacks permission for this route.`);
      return <Navigate to="/" replace />;
    }
  }

  return children;
};

export default ProtectedRoute;
