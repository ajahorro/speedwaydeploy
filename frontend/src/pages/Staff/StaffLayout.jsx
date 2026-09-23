import React, { useCallback, useEffect } from 'react';
import { Outlet, useNavigate, Link, NavLink, useLocation } from 'react-router-dom';
import {
  ClipboardList,
  Menu, Bell, History, Clock, Settings, LogOut
} from 'lucide-react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { supabase } from '../../lib/supabase';
import { useUI } from '../../context/UIContext';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../context/ThemeContext';
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

  const sidebarStyle = {
    width: '260px',
    background: 'var(--admin-sidebar)',
    borderRight: '1px solid var(--admin-border)',
    display: 'flex',
    flexDirection: 'column',
    padding: '0',
    position: 'fixed',
    top: 0,
    left: isMobile ? (isSidebarOpen ? 0 : '-260px') : 0,
    height: '100vh',
    flexShrink: 0,
    zIndex: 1000,
    transition: 'left 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const overlayStyle = {
    display: isMobile && isSidebarOpen ? 'block' : 'none',
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.7)',
    backdropFilter: 'blur(8px)',
    zIndex: 999,
  };

  return (
    <div className="admin-theme" data-theme={resolvedTheme} style={{ display: 'flex', width: '100vw', height: '100vh', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', fontFamily: 'Inter, system-ui, sans-serif', overflow: 'hidden' }}>

      <div style={overlayStyle} onClick={() => setIsSidebarOpen(false)} />

      <aside style={sidebarStyle}>
        <div style={{
          padding: '2rem 1.5rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: '0.1rem',
          borderBottom: '1px solid var(--admin-border)',
          marginBottom: '1rem',
          background: 'rgba(var(--admin-brand-rgb), 0.03)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', justifyContent: 'space-between' }}>
            <h1 style={{ fontSize: '1.25rem', fontWeight: '950', margin: 0, fontStyle: 'italic', letterSpacing: '1px', color: 'var(--admin-text-primary)' }}>
              SPEEDWAY<span style={{ color: 'var(--admin-brand)' }}>STAFF</span>
            </h1>
            {isMobile && (
              <button onClick={() => setIsSidebarOpen(false)} style={{ color: 'var(--admin-text-primary)', background: 'none', border: 'none', cursor: 'pointer' }}>
                <Menu size={20} />
              </button>
            )}
          </div>
          <p style={{ fontSize: '0.6rem', color: 'var(--admin-text-secondary)', fontWeight: '900', marginTop: '0.4rem', textTransform: 'uppercase', letterSpacing: '2px', opacity: 0.8 }}>
            Operational Detailing Portal
          </p>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 0.5rem' }}>
          {menuItems.map((item) => (
            <Link key={item.path} to={item.path} className="admin-card-hover" style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '0.85rem',
              padding: '0.7rem 1.25rem',
              borderRadius: 'var(--admin-radius-sm)',
              textDecoration: 'none',
              color: isActive ? 'var(--admin-sidebar-active-text)' : 'var(--admin-text-secondary)',
              background: isActive ? 'var(--admin-sidebar-active-bg)' : 'transparent',
              fontWeight: isActive ? '800' : '600',
              fontSize: '0.8rem',
              letterSpacing: 0,
              transition: 'all 0.2s',
              borderLeft: isActive ? '3px solid var(--admin-brand)' : '3px solid transparent',
              marginLeft: '0',
            })} onClick={() => isMobile && setIsSidebarOpen(false)}>
              <item.icon size={16} strokeWidth={2.25} />
              {item.label}
            </Link>
          ))}
        </nav>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', padding: '1rem 0.5rem', borderTop: '1px solid var(--admin-border)' }}>
          <div style={{ padding: '0 1rem 0.5rem', fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', opacity: 0.55 }}>System</div>

          <NavLink
            to="/staff/settings"
            className="admin-card-hover"
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              padding: '0.85rem 1.25rem',
              borderRadius: 'var(--admin-radius-sm)',
              textDecoration: 'none',
              color: isActive ? 'var(--admin-sidebar-active-text)' : 'var(--admin-text-secondary)',
              background: isActive ? 'var(--admin-sidebar-active-bg)' : 'transparent',
              fontWeight: isActive ? '950' : '800',
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.8px',
              borderLeft: isActive ? '2px solid var(--admin-brand)' : '2px solid transparent',
              marginLeft: '0.25rem'
            })}
          >
            <Settings size={14} strokeWidth={2.5} />
            Settings
          </NavLink>

          <button
            onClick={handleLogout}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              padding: '0.85rem 1.25rem',
              borderRadius: 'var(--admin-radius-sm)',
              color: 'var(--admin-text-secondary)',
              fontWeight: '950',
              fontSize: '0.7rem',
              width: '100%',
              textAlign: 'left',
              cursor: 'pointer',
              transition: 'all 0.2s',
              background: 'transparent',
              border: 'none',
              textTransform: 'uppercase',
              letterSpacing: '0.8px',
              marginLeft: '0.25rem'
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--admin-brand)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--admin-text-secondary)'}
          >
            <LogOut size={14} strokeWidth={2.5} />
            Log out
          </button>

          <div style={{ padding: '1rem 1rem 0', borderTop: '1px solid var(--admin-border)', marginTop: '0.5rem' }}>
            <div style={{ fontSize: '0.6rem', fontWeight: '800', color: 'var(--admin-text-secondary)', letterSpacing: '1px', textTransform: 'uppercase' }}>
              Signed in as
            </div>
            <div style={{ fontSize: '0.8rem', fontWeight: '900', color: 'var(--admin-text-primary)', marginTop: '0.35rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {profile?.full_name || 'Technician'}
            </div>
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
          padding: isMobile ? '0.75rem 1rem' : '0 2rem', position: 'sticky', top: 0, zIndex: 30,
          overflowX: 'visible', maxWidth: '100%', boxShadow: 'var(--admin-card-shadow)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '1rem' : '0.75rem', minWidth: 0, flexShrink: 1 }}>
            {isMobile && (
              <button onClick={() => setIsSidebarOpen(true)} style={{ color: 'var(--admin-text-primary)', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, padding: 0 }}>
                <Menu size={20} />
              </button>
            )}
            {/* Hidden on mobile so the header stays within 375px. */}
            {!isMobile && (
              <h2 style={{ fontSize: '0.9rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '2px', whiteSpace: 'nowrap' }}>
                Operational Overview
              </h2>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '1rem' : '1.25rem', flexWrap: 'nowrap', overflowX: 'hidden', flexShrink: 0 }}>
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

            <button
              onClick={() => navigate('/staff/notifications')}
              style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)', padding: '0.5rem', borderRadius: '4px', cursor: 'pointer', position: 'relative', opacity: unreadCount > 0 ? 1 : 0.6, transition: 'all 0.2s' }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
              onMouseLeave={(e) => { if (unreadCount <= 0) e.currentTarget.style.opacity = '0.6'; }}
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
