import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { logger } from '../utils/logger';

/**
 * AuthCallback.jsx
 * ============================================================================
 * The landing page for Supabase auth email links (signup confirmation, password
 * recovery, email change).
 *
 * WHY THIS EXISTS — the "confirmation links don't lead where they are intended"
 * defect
 * -------------------------------------------------------------------------
 * `signUp()` passed `emailRedirectTo: ${window.location.origin}/login`. Supabase
 * appends the session as a URL FRAGMENT:
 *
 *     https://<your-domain>/login#access_token=...&refresh_token=...&type=signup
 *
 * A fragment is never sent to the server and is not a route parameter, so the
 * login page received a normal `/login` request and rendered the login FORM. The
 * session in the fragment was never read, so the freshly-confirmed customer was
 * shown a login screen instead of being signed in — exactly "the link does not
 * lead where it is intended". The account WAS confirmed; the landing was wrong.
 *
 * A second, subtler failure: `detectSessionInUrl` is a client-construction
 * option. If the browser client does not process the fragment, nothing consumes
 * it at all.
 *
 * WHAT THIS PAGE DOES
 * -------------------
 *   1. Reads the fragment/query itself (no reliance on client config).
 *   2. Establishes the session from the tokens or the `token_hash` + `type`.
 *   3. Sends the user where they belong by ROLE, not to a generic login page.
 *   4. Reports a genuine failure honestly instead of silently showing a form.
 *
 * A fragment can also carry an `error` (e.g. an expired link), which is surfaced
 * rather than swallowed.
 * ============================================================================
 */

const readParams = () => {
  // Fragments carry the session for implicit/OTP flows; the query string carries
  // `token_hash`/`type` for the PKCE and email-OTP flows. Read both.
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const get = (key) => fragment.get(key) || query.get(key);
  return { fragment, query, get };
};

/** Where a given role should land after authenticating. */
const routeForRole = (role) => {
  switch (String(role || '').toUpperCase()) {
    case 'ADMIN': return '/admin';
    case 'STAFF': return '/staff';
    default: return '/customer';
  }
};

const AuthCallback = () => {
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'working', message: 'Confirming your account…' });

  useEffect(() => {
    let cancelled = false;

    const resolveRoleAndRedirect = async (userId) => {
      let role = 'CUSTOMER';
      if (userId) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', userId)
          .maybeSingle();
        if (profile?.role) role = profile.role;
      }
      if (cancelled) return;
      const destination = routeForRole(role);
      logger.auth('[AuthCallback] Confirmed; redirecting to', destination);
      setState({ status: 'done', message: 'Account confirmed. Redirecting…' });
      navigate(destination, { replace: true });
    };

    const run = async () => {
      const { get } = readParams();

      // An expired or already-used link arrives as an error in the fragment.
      const linkError = get('error_description') || get('error');
      if (linkError) {
        const friendly = /expired|invalid/i.test(linkError)
          ? 'This confirmation link has expired or was already used. Sign in, or request a new link from the login screen.'
          : String(linkError);
        logger.warn('[AuthCallback] Link error:', linkError);
        if (!cancelled) setState({ status: 'error', message: friendly });
        return;
      }

      try {
        // ── Path A: a `token_hash` + `type` pair (email OTP / PKCE flow) ──────
        const tokenHash = get('token_hash');
        const type = get('type');
        if (tokenHash && type) {
          const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
          if (error) throw error;
          await resolveRoleAndRedirect(data?.user?.id);
          return;
        }

        // ── Path B: tokens already in the fragment (implicit flow) ──────────
        // getSession() resolves the session whether the client processed the
        // fragment at construction time or not, and refreshes if needed.
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;

        if (session?.user) {
          await resolveRoleAndRedirect(session.user.id);
          return;
        }

        // ── Path C: nothing usable — say so rather than showing a blank form ─
        if (!cancelled) {
          setState({
            status: 'error',
            message: 'We could not confirm this link. It may have expired or already been used. Please sign in or request a new confirmation email.',
          });
        }
      } catch (err) {
        logger.error('[AuthCallback] Failed to complete sign-in:', err);
        if (!cancelled) {
          setState({
            status: 'error',
            message: err?.message
              ? `We could not confirm your account: ${err.message}`
              : 'We could not confirm your account. Please sign in or request a new confirmation email.',
          });
        }
      }
    };

    run();
    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f1115',
      color: '#f9fafb',
      fontFamily: "'Segoe UI', Tahoma, sans-serif",
      padding: '24px',
    }}>
      <div style={{
        maxWidth: '460px',
        width: '100%',
        background: '#171a21',
        border: '1px solid #262b36',
        borderRadius: '12px',
        padding: '32px 28px',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '2px', color: '#e61e2a' }}>
          SPEEDWAY AUTOXMOTO
        </div>

        <p style={{ marginTop: '20px', fontSize: '15px', lineHeight: 1.6, color: state.status === 'error' ? '#fca5a5' : '#d1d5db' }}>
          {state.message}
        </p>

        {state.status === 'error' && (
          <button
            type="button"
            onClick={() => navigate('/login', { replace: true })}
            style={{
              marginTop: '22px',
              background: '#e61e2a',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              padding: '12px 22px',
              fontWeight: 700,
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            GO TO SIGN IN
          </button>
        )}
      </div>
    </div>
  );
};

export default AuthCallback;