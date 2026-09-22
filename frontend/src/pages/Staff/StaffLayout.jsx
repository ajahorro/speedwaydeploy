import React, { useCallback, useEffect } from 'react';
import { Outlet, useNavigate, Link, useLocation } from 'react-router-dom';
import {
  ClipboardList,
  Menu, Bell, History, Clock
} from 'lucide-react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { supabase } from '../../lib/supabase';
import { useUI } from '../../context/UIContext';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../context/ThemeContext';
import ThemeToggle from '../../components/ThemeToggle';
import HeaderProfileDropdown from '../../components/common/HeaderProfileDropdown';
import { confirmLogout } from '../../utils/logoutConfirm';

const StaffLayout = () => {
  const { openModal, closeModal } = useUI(); const { user, profile, signOut, fetchProfile, setProfile, toggleShift } = useAuth();
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(!isMobile);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const userId = user?.id || profile?.id;

  const fetchUnreadCount = useCallback(async () => {
    if (!userId) return;
    try {
      const { count } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_read', false);
      setUnreadCount(count || 0);
    } catch {
      setUnreadCount(0);
    }
  }, [userId]);

  useEffect(() => {
    fetchUnreadCount();
    if (!userId) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchUnreadCount();
      }
    };

    window.addEventListener('visibilitychange', handleVisibilityChange);

    const channel = supabase
      .channel(`staff-notif-badge-${userId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'notifications',
        filter: `user_id=eq.${userId}`
      }, () => fetchUnreadCount())
      .subscribe();

    return () => {
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      supabase.removeChannel(channel);
    };
  }, [userId, fetchUnreadCount]);

  const menuItems = [
    { icon: ClipboardList, label: 'My Jobs', path: '/staff' },
    { icon: History, label: 'Work History', path: '/staff/history' },
    { icon: Clock, label: 'Duty & Shift', path: '/staff/duty' },
  ];

  const handleToggleShift = async () => {
    // Defensive: bail out cleanly when the profile is not yet loaded or the
    // toggle implementation is unavailable — never reach the API without an id.
    if (!profile?.id || typeof toggleShift !== 'function') return;
    const isClockingOut = Boolean(profile.is_clocked_in);

    if (isClockingOut) {
      openModal({
        title: "End Shift?",
        message: "Confirming clock-out will mark you as unavailable for new detailing assignments.",
        confirmText: "Clock Out",
        type: "danger",
        onConfirm: async () => {
          if (!profile?.id || typeof toggleShift !== 'function') return;
          await toggleShift(false);
        }
      });
      return;
    }

    await toggleShift(true);
  };

  const handleLogout = () => {
    confirmLogout(openModal, async () => {
      // 1. Close any active modal first to prevent UI flashes
      if (typeof closeModal === 'function') {
        closeModal();
      }

      // 2. Perform sign out
      await signOut();

      // 3. Force clean redirect to homepage
      window.location.href = '/';
    });
  };

  const navItemStyle = (path) => {
    const isActive = location.pathname === path || (path === '/staff' && (location.pathname === '/staff' || location.pathname === '/staff/tasks'));
    return {
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '0.85rem 1.25rem',
      borderRadius: '4px',
      color: isActive ? 'var(--admin-text-on-brand)' : 'var(--admin-text-secondary)',
      background: isActive ? 'var(--admin-brand)' : 'transparent',
      textDecoration: 'none',
      fontWeight: '800',
      fontSize: '0.85rem',
      transition: 'all 0.2s ease',
      textTransform: 'uppercase',
      letterSpacing: '0.5px'
    };
  };

  return (
    <div className="admin-theme" data-theme={resolvedTheme} style={{ display: 'flex', width: '100vw', height: '100vh', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', fontFamily: 'Inter, system-ui, sans-serif', overflow: 'hidden' }}>

      {/* Mobile Backdrop */}
      {isMobile && isSidebarOpen && (
        <div
          onClick={() => setIsSidebarOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'var(--modal-overlay)', zIndex: 40, backdropFilter: 'blur(4px)' }}
        />
      )}

      {/* Sidebar */}
      <aside style={{
        width: '280px',
        background: 'var(--admin-card)',
        borderRight: '1px solid var(--admin-border)',
        display: 'flex',
        flexDirection: 'column',
        position: isMobile ? 'fixed' : 'relative',
        height: '100vh',
        flexShrink: 0,
        zIndex: 50,
        transform: isMobile && !isSidebarOpen ? 'translateX(-100%)' : 'translateX(0)',
        transition: 'transform 0.3s ease'
      }}>
        <div style={{ padding: '2rem', borderBottom: '1px solid var(--admin-border)' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: '950', margin: 0, fontStyle: 'italic', letterSpacing: '1px' }}>
            SPEEDWAY<span style={{ color: 'var(--admin-brand)' }}>STAFF</span>
          </h1>
          <p style={{ fontSize: '0.6rem', color: 'var(--admin-text-secondary)', fontWeight: '900', marginTop: '0.4rem', textTransform: 'uppercase', letterSpacing: '2px' }}>
            Operational Detailing Portal
          </p>
        </div>

        <nav style={{ flex: 1, padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {menuItems.map((item) => (
            <Link key={item.path} to={item.path} className="admin-card-hover" style={navItemStyle(item.path)} onClick={() => isMobile && setIsSidebarOpen(false)}>
              <item.icon size={18} />
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Clean footer: profile, Settings and Logout now live in the header
            dropdown; the clock action lives on the Duty & Shift page. */}
        <div style={{ padding: '1.5rem', borderTop: '1px solid var(--admin-border)' }}>
          <div style={{ fontSize: '0.6rem', fontWeight: '800', color: 'var(--admin-text-secondary)', letterSpacing: '1px', textTransform: 'uppercase' }}>
            Signed in as
          </div>
          <div style={{ fontSize: '0.8rem', fontWeight: '900', color: 'var(--admin-text-primary)', marginTop: '0.35rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {profile?.full_name || 'Technician'}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main style={{ flex: 1, minWidth: 0, height: '100vh', overflowY: 'auto', position: 'relative', background: 'var(--admin-bg)' }}>
        {/* Top Header */}
        <header style={{
          height: '70px', background: 'var(--admin-card)', backdropFilter: 'blur(10px)',
          borderBottom: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: '0.75rem',
          padding: isMobile ? '0 0.85rem' : '0 2rem', position: 'sticky', top: 0, zIndex: 30,
          // 375px guard: never allow the header to scroll horizontally.
          overflowX: 'hidden', maxWidth: '100%'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flexShrink: 1 }}>
            {isMobile && (
              <button onClick={() => setIsSidebarOpen(true)} style={{ background: 'none', border: 'none', color: 'var(--admin-text-primary)', cursor: 'pointer', flexShrink: 0, padding: 0 }}>
                <Menu size={24} />
              </button>
            )}
            {/* Hidden on mobile so the header stays within 375px. */}
            {!isMobile && (
              <h2 style={{ fontSize: '0.9rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '2px', whiteSpace: 'nowrap' }}>
                Operational Overview
              </h2>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '0.6rem' : '1.25rem', flexWrap: 'nowrap', overflowX: 'hidden', flexShrink: 0 }}>
            {/* 🟢 Header Status Badge */}
            <div style={{
              padding: isMobile ? '0.35rem 0.6rem' : '0.4rem 0.85rem', background: 'var(--admin-input-bg)',
              borderRadius: '100px', border: '1px solid var(--admin-border)',
              display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0
            }}>
              <div style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: profile?.is_clocked_in ? 'var(--status-success)' : 'var(--status-danger)',
                boxShadow: profile?.is_clocked_in ? '0 0 10px var(--status-success)' : 'none'
              }}></div>
              {!isMobile && (
                <span style={{ fontSize: '0.65rem', fontWeight: '950', color: profile?.is_clocked_in ? 'var(--status-success)' : 'var(--status-danger)', textTransform: 'uppercase', letterSpacing: '1px', whiteSpace: 'nowrap' }}>
                  {profile?.is_clocked_in ? 'ON DUTY' : 'OFF DUTY'}
                </span>
              )}
            </div>

            {/* Section 1.3: tri-state theme selector, mirroring the Admin shell. */}
            <ThemeToggle variant="icon" />

            <button
              onClick={() => navigate('/staff/notifications')}
              style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)', padding: '0.5rem', borderRadius: '4px', cursor: 'pointer', position: 'relative' }}
            >
              <Bell size={18} />
              {unreadCount > 0 && (
                <span style={{
                  position: 'absolute', top: '-4px', right: '-4px',
                  background: 'var(--admin-brand)', color: 'var(--admin-text-primary)',
                  fontSize: '0.5rem', fontWeight: '950',
                  minWidth: '16px', height: '16px', padding: '0 3px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: '2px', border: '1.5px solid var(--admin-card)'
                }}>{unreadCount > 99 ? '99+' : unreadCount}</span>
              )}
            </button>

            {/* Shared identity menu — one component for every role portal. */}
            <HeaderProfileDropdown
              user={user}
              profile={profile}
              roleTitle="Staff Member"
              profilePath="/staff/profile"
              settingsPath="/staff/settings"
              onLogoutClick={handleLogout}
            />
          </div>
        </header>

        <div style={{ padding: isMobile ? '1.5rem' : '2.5rem', maxWidth: '1400px', margin: '0 auto', minHeight: 0, overflow: 'hidden' }}>
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default StaffLayout;
