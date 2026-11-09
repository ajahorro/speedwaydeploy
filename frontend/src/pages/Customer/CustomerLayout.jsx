import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { subscribeTable } from '../../lib/realtimeHub';
import { Bell, Menu, X } from 'lucide-react';
import { NAV_ICONS, SidebarLink, SidebarButton } from '../../components/sidebar/SidebarNav';
import HeaderProfileDropdown from '../../components/common/HeaderProfileDropdown';
import NotificationPopover from '../../components/NotificationPopover';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useTheme } from '../../context/ThemeContext';
import { useUI } from '../../context/UIContext';
import { useAuth } from '../../hooks/useAuth';
import { confirmLogout } from '../../utils/logoutConfirm';
import CustomerSearch from '../../components/CustomerSearch';
import FloatingBubbleChat from '../../components/FloatingBubbleChat';
import TermsGate from '../../components/TermsGate';
import LanguageGate from '../../components/LanguageGate';

const CustomerLayout = () => {
  const { openModal, closeModal } = useUI(); const { resolvedTheme } = useTheme();
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifPopover, setShowNotifPopover] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDesktopCollapsed, setIsDesktopCollapsed] = useState(() => localStorage.getItem('comar_sidebar_customer_collapsed') === 'true');
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const notifRef = useRef(null);

  const toggleSidebar = () => {
    if (isMobile) {
      setIsSidebarOpen((prev) => !prev);
    } else {
      setIsDesktopCollapsed((prev) => {
        const next = !prev;
        localStorage.setItem('comar_sidebar_customer_collapsed', String(next));
        return next;
      });
    }
  };
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notifRef.current && !notifRef.current.contains(event.target)) {
        setShowNotifPopover(false);
      }
    };

    if (showNotifPopover) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showNotifPopover]);

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    if (isMobile) setIsSidebarOpen(false);
  }, [location, isMobile]);

  const fetchUnreadCount = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .or('is_read.eq.false,is_read.is.null');
      if (error) {
        console.error('[CustomerLayout] Failed to fetch unread count:', error);
        return;
      }
      setUnreadCount(count || 0);
    } catch (err) { // 2. Added '(err)' parameter here
      console.error('[CustomerLayout] Exception fetching unread count:', err);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchUnreadCount();

    // Real-time subscription for instant badge updates
    return subscribeTable({ table: 'notifications', filter: `user_id=eq.${user?.id}` }, () => fetchUnreadCount());
  }, [user?.id, fetchUnreadCount]);

  const handleLogout = () => {
    confirmLogout(openModal, async () => {
      // 1. Close any active modal first to prevent UI flashes
      if (typeof closeModal === 'function') {
        closeModal();
      }

      // 2. Sign out and go straight to the next page
      await signOut('/');
    });
  };

  const navSections = [
    { title: 'Main', links: [{ name: 'Dashboard', path: '/customer', icon: NAV_ICONS.dashboard, exact: true }] },
    { title: 'Bookings', links: [{ name: 'Book Appointment', path: '/customer/book', icon: NAV_ICONS.newBooking }, { name: 'My Bookings', path: '/customer/bookings', icon: NAV_ICONS.bookings }] },
    { title: 'Garage & Billing', links: [{ name: 'Transactions & Billing', path: '/customer/billing', icon: NAV_ICONS.billing }, { name: 'Vehicle Garage', path: '/customer/garage', icon: NAV_ICONS.garage }, { name: 'Notifications', path: '/customer/notifications', icon: NAV_ICONS.notifications }] }
  ];

  const sidebarStyle = {
    width: '260px',
    background: 'var(--admin-sidebar)',
    borderRight: '1px solid var(--admin-border)',
    display: 'flex',
    flexDirection: 'column',
    padding: '0',
    position: 'fixed',
    top: 0,
    left: isMobile ? (isSidebarOpen ? 0 : '-260px') : (isDesktopCollapsed ? '-260px' : 0),
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
    zIndex: 999
  };

  return (
    <div className="admin-theme" data-theme={resolvedTheme} style={{ display: 'flex', width: '100vw', height: '100vh', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', position: 'relative', overflow: 'hidden' }}>

      {/* Mobile Overlay */}
      <div style={overlayStyle} onClick={() => setIsSidebarOpen(false)} />

      <aside className="no-print" style={sidebarStyle}>
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
            <div style={{ fontWeight: '950', fontSize: '1.25rem', letterSpacing: '-1px', color: 'var(--admin-brand)', lineHeight: 1 }}>COMAR GARAGE</div>
            {isMobile && <button onClick={() => setIsSidebarOpen(false)} style={{ color: 'var(--admin-text-primary)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>}
          </div>
          <span style={{ fontSize: '0.55rem', fontWeight: '950', color: 'var(--admin-text-secondary)', letterSpacing: '2px', textTransform: 'uppercase' }}>Customer Portal</span>
        </div>

        <nav data-tour="cust-nav" style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 0.5rem' }}>
          {navSections.map(section => (
            <div key={section.title}>
              <div style={{ padding: '0.75rem 1rem 0.5rem', fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', opacity: 0.55 }}>{section.title}</div>
              {section.links.map((link) => (
                <SidebarLink key={link.name} to={link.path} end={link.exact} icon={link.icon}>{link.name}</SidebarLink>
              ))}
            </div>
          ))}
        </nav>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', padding: '1rem 0.5rem', borderTop: '1px solid var(--admin-border)' }}>
          <div style={{ padding: '0 1rem 0.5rem', fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', opacity: 0.55 }}>System</div>
          <SidebarLink to="/customer/settings" icon={NAV_ICONS.settings}>Settings</SidebarLink>

          <SidebarButton icon={NAV_ICONS.logout} onClick={handleLogout}>Log out</SidebarButton>
        </div>
      </aside>

      <div className="admin-main-wrapper" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', maxWidth: '100%', height: '100vh', overflow: 'hidden', marginLeft: isMobile ? 0 : (isDesktopCollapsed ? 0 : '260px'), transition: 'margin-left 0.4s cubic-bezier(0.16, 1, 0.3, 1)' }}>
        <header className="no-print" style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: isMobile ? '0.75rem 1rem' : '1rem 2.5rem',
          borderBottom: '1px solid var(--admin-border)',
          background: 'var(--admin-card)',
          position: 'sticky',
          top: 0,
          zIndex: 50,
          boxShadow: 'var(--admin-card-shadow)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '1rem' : '2rem' }}>
            <button onClick={toggleSidebar} aria-label="Toggle menu" style={{ color: 'var(--admin-text-primary)', background: 'none', border: 'none', cursor: 'pointer' }}>
              <Menu size={20} />
            </button>
            <div
              style={{ fontSize: isMobile ? '0.9rem' : '1.1rem', fontWeight: '950', letterSpacing: '1px', cursor: 'pointer', color: 'var(--admin-text-primary)', textTransform: 'uppercase' }}
              onClick={() => navigate('/customer')}
            >
              Customer Account
            </div>
            {!isMobile && <CustomerSearch />}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '1rem' : '1.5rem', position: 'relative' }}>
            <div
              onClick={() => setShowNotifPopover(!showNotifPopover)}
              style={{ position: 'relative', cursor: 'pointer', opacity: showNotifPopover ? 1 : 0.6, color: 'var(--admin-text-primary)', transition: 'all 0.2s' }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
              onMouseLeave={(e) => { if (!showNotifPopover) e.currentTarget.style.opacity = '0.6'; }}
            >
              <Bell size={18} strokeWidth={2.5} />
              {unreadCount > 0 && (
                <div style={{
                  position: 'absolute',
                  top: '-6px',
                  right: '-6px',
                  background: 'var(--admin-brand)',
                  color: 'var(--admin-text-on-brand)',
                  fontSize: '0.55rem',
                  fontWeight: '950',
                  minWidth: '16px',
                  height: '16px',
                  padding: '0 4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '2px',
                  border: '1px solid var(--admin-card)',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                }}>{unreadCount}</div>
              )}
            </div>

            {showNotifPopover && (
              <div ref={notifRef}>
                <NotificationPopover
                  user={user}
                  profile={profile}
                  onClose={() => setShowNotifPopover(false)}
                  onRead={fetchUnreadCount}
                />
              </div>
            )}
            <div style={{ width: '1px', height: '20px', background: 'var(--admin-border)', opacity: 0.5 }}></div>
            {/* Shared identity menu — replaces the legacy static profile chip. */}
            <HeaderProfileDropdown
              user={user}
              profile={profile}
              roleTitle="Customer"
              profilePath="/customer/profile"
              settingsPath="/customer/settings"
              onLogoutClick={handleLogout}
            />
          </div>
        </header>

        {isMobile && (
          <div className="portal-search-row" style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--admin-border)', background: 'var(--admin-bg)' }}>
            <CustomerSearch />
          </div>
        )}

        <main style={{ flex: 1, minHeight: 0, padding: isMobile ? '1.5rem 1rem' : '2.5rem', overflowY: 'auto', scrollPaddingTop: 'var(--app-shell-header-height)', background: 'var(--admin-bg)' }}>
          <Outlet />
        </main>
        <TermsGate />
        <LanguageGate />
        <FloatingBubbleChat />
      </div>
    </div>
  );
};

export default CustomerLayout;
