import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { logger } from '../utils/logger';
import MustChangePasswordGate from './auth/MustChangePasswordGate';

const ProtectedRoute = ({ children, allowedRoles = [] }) => {
  const { user, profile, isInitialized, loading } = useAuth();
  const location = useLocation();

  // 1. Session Gate: Only block UI while we're unsure if a session exists
  if (!isInitialized) {
    return (
      <div style={{
        height: '100vh', width: '100vw', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--admin-bg)', color: 'var(--admin-brand)',
        fontWeight: '950', letterSpacing: '2px', fontSize: '0.8rem'
      }}>
        AUTHENTICATING...
      </div>
    );
  }

  // 2. Authentication Check: No session? Straight to Login.
  if (!user) {
    return <Navigate to="/" replace />;
  }

  // 3. Optional Profile Enrichment Gate:
  // If a route specifically requires a role check, we only wait if we don't have the profile yet.
  if (allowedRoles.length > 0 && !profile) {
    // If it's still loading the profile, show a subtle progress bar or message
    return (
      <div style={{
        height: '100vh', width: '100vw', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--admin-bg)', color: 'var(--admin-text-secondary)',
        fontSize: '0.7rem', fontWeight: '950', letterSpacing: '1px'
      }}>
        SYNCHRONIZING PERMISSIONS...
      </div>
    );
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
