import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Settings, LogOut } from 'lucide-react';
import { useMediaQuery } from '../../hooks/useMediaQuery';

/**
 * HeaderProfileDropdown
 * ---------------------------------------------------------------------------
 * The single, shared identity menu for every role portal (Admin, Customer,
 * Staff). It replaces the per-layout static profile chips so that "My Profile",
 * "Settings" and "Log Out" behave identically everywhere.
 *
 * SAFETY CONTRACT
 *  - `profilePath` / `settingsPath` are validated as non-empty strings. A menu
 *    item whose target is missing/blank is rendered DISABLED rather than
 *    navigating to `undefined` (which would blank the app).
 *  - Logout never signs out directly. It only calls `onLogoutClick()`, which the
 *    host layout wires to the system-wide confirmation modal. If no handler is
 *    supplied, the item is omitted entirely instead of offering a dead control.
 *  - Click-outside and Escape both close the menu; the document listeners are
 *    removed on unmount and whenever the menu closes.
 *
 * Props:
 *   user         – current auth user object (optional; used for email fallback)
 *   profile      – profile row (full_name / first_name / last_name / role)
 *   roleTitle    – display label, e.g. "Administrator" | "Customer" | "Staff Member"
 *   profilePath  – route string for My Profile
 *   settingsPath – route string for Settings
 *   onLogoutClick– () => void that opens the global LogoutConfirmationModal
 */
const HeaderProfileDropdown = ({
  user,
  profile,
  roleTitle = 'User',
  profilePath,
  settingsPath,
  onLogoutClick,
}) => {
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  const hasRoute = (value) => typeof value === 'string' && value.trim().length > 0;
  const canNavigateProfile = hasRoute(profilePath);
  const canNavigateSettings = hasRoute(settingsPath);
  const canLogout = typeof onLogoutClick === 'function';

  // ── Close on outside click / Escape ────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return undefined;

    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // ── Derived identity (defensive against a null/partial profile) ────────────
  const firstName = profile?.first_name || '';
  const lastName = profile?.last_name || '';
  const fallbackName = profile?.full_name || user?.email || 'User';
  const fullName = (firstName || lastName)
    ? `${firstName} ${lastName}`.trim()
    : fallbackName;
  const initial = (firstName || profile?.full_name || user?.email || 'U')
    .charAt(0)
    .toUpperCase();

  const handleNavigate = useCallback((path) => {
    setIsOpen(false);
    if (hasRoute(path)) navigate(path);
  }, [navigate]);

  const itemBaseStyle = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.7rem 0.85rem',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--admin-radius-sm, 4px)',
    color: 'var(--admin-text-primary)',
    fontWeight: '700',
    fontSize: '0.82rem',
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'background 0.15s ease',
  };

  const disabledItemStyle = {
    ...itemBaseStyle,
    color: 'var(--admin-text-secondary)',
    opacity: 0.45,
    cursor: 'not-allowed',
  };

  return (
    <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`Account menu for ${fullName}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '0.25rem',
        }}
      >
        {/* 375px guard: the text identity collapses below md; only the avatar stays. */}
        {!isMobile && (
          <span style={{ textAlign: 'right', minWidth: 0 }}>
            <span style={{
              display: 'block',
              fontSize: '0.75rem',
              fontWeight: '900',
              color: 'var(--admin-text-primary)',
              lineHeight: 1.2,
              maxWidth: '160px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {fullName}
            </span>
            <span style={{ display: 'block', fontSize: '0.6rem', color: 'var(--admin-text-secondary)', fontWeight: '700' }}>
              {roleTitle}
            </span>
          </span>
        )}
        <span style={{
          width: '34px',
          height: '34px',
          borderRadius: '50%',
          background: 'var(--admin-brand)',
          color: 'var(--admin-text-on-brand)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: '900',
          fontSize: '0.85rem',
          flexShrink: 0,
        }}>
          {initial}
        </span>
      </button>

      {isOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 0.5rem)',
            right: 0,
            minWidth: '200px',
            maxWidth: 'min(280px, 90vw)',
            background: 'var(--admin-card)',
            border: '1px solid var(--admin-border)',
            borderRadius: 'var(--admin-radius, 8px)',
            boxShadow: 'var(--admin-card-shadow)',
            padding: '0.35rem',
            zIndex: 60,
            overflow: 'hidden',
          }}
        >
          {/* Identity header (email) — useful context, never a nav target. */}
          <div style={{ padding: '0.6rem 0.85rem 0.5rem', borderBottom: '1px solid var(--admin-border)', marginBottom: '0.35rem' }}>
            <div style={{ fontSize: '0.78rem', fontWeight: '800', color: 'var(--admin-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {fullName}
            </div>
            <div style={{ fontSize: '0.68rem', fontWeight: '600', color: 'var(--admin-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {profile?.email || user?.email || roleTitle}
            </div>
          </div>

          <button
            type="button"
            role="menuitem"
            disabled={!canNavigateProfile}
            onClick={() => canNavigateProfile && handleNavigate(profilePath)}
            className={canNavigateProfile ? 'admin-card-hover' : undefined}
            style={canNavigateProfile ? itemBaseStyle : disabledItemStyle}
          >
            <User size={16} /> My Profile
          </button>

          <button
            type="button"
            role="menuitem"
            disabled={!canNavigateSettings}
            onClick={() => canNavigateSettings && handleNavigate(settingsPath)}
            className={canNavigateSettings ? 'admin-card-hover' : undefined}
            style={canNavigateSettings ? itemBaseStyle : disabledItemStyle}
          >
            <Settings size={16} /> Settings
          </button>

          {canLogout && (
            <>
              <div style={{ height: '1px', background: 'var(--admin-border)', margin: '0.35rem 0' }} />
              <button
                type="button"
                role="menuitem"
                onClick={() => { setIsOpen(false); onLogoutClick(); }}
                style={{
                  ...itemBaseStyle,
                  color: 'var(--status-danger)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--modal-hover-bg)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <LogOut size={16} /> Logout
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default HeaderProfileDropdown;