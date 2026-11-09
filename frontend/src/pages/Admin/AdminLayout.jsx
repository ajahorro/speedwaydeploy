import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate, NavLink, Outlet } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { subscribeTable } from '../../lib/realtimeHub';
import { Menu, X, Bell } from 'lucide-react';
import { NAV_ICONS, SidebarLink, SidebarButton } from '../../components/sidebar/SidebarNav';
import { useUI } from '../../context/UIContext';
import { useGlobalChat } from '../../context/ChatContext';
import { useAuth } from '../../hooks/useAuth';
import { confirmLogout } from '../../utils/logoutConfirm';
import HeaderProfileDropdown from '../../components/common/HeaderProfileDropdown';
import AdminSearch from '../../components/AdminSearch';
import FloatingBubbleChat from '../../components/FloatingBubbleChat';
import NotificationPopover from '../../components/NotificationPopover';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useTheme } from '../../context/ThemeContext';
import BrandLogo from '../../components/BrandLogo';
import toastManager from '../../utils/toastManager';
import { NotificationToast } from '@/components/ui/notification-toast';
import TermsGate from '../../components/TermsGate';
import LanguageGate from '../../components/LanguageGate';

const AdminLayout = () => {
  const { resolvedTheme } = useTheme();
  const { user, profile, signOut } = useAuth();
  const { globalUnreadCount } = useGlobalChat();
  const navigate = useNavigate();
  const location = useLocation();
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifPopover, setShowNotifPopover] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDesktopCollapsed, setIsDesktopCollapsed] = useState(() => localStorage.getItem('comar_sidebar_admin_collapsed') === 'true');
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const notifRef = useRef(null);
  const { openModal, closeModal } = useUI();

  const toggleSidebar = () => {
    if (isMobile) {
      setIsSidebarOpen((prev) => !prev);
    } else {
      setIsDesktopCollapsed((prev) => {
        const next = !prev;
        localStorage.setItem('comar_sidebar_admin_collapsed', String(next));
        return next;
      });
    }
  };

  useEffect(() => {
    document.body.classList.add('admin-account-active');
    return () => document.body.classList.remove('admin-account-active');
  }, []);

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

  const fetchUnreadCount = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { count } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('is_read', false);
      setUnreadCount(count || 0);
    } catch {
      setUnreadCount(0);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchUnreadCount();

    const handleNotificationsRead = () => fetchUnreadCount();
    window.addEventListener('notificationsRead', handleNotificationsRead);

    // Real-time subscription for instant badge updates
    const stopRealtime = subscribeTable({ table: 'notifications', filter: `user_id=eq.${user?.id}` }, (payload) => {
        fetchUnreadCount();

        // Live toast for a NEW booking landing while the admin is on-screen.
        // The DB trigger fans one notification row per active admin, so this
        // fires for every admin, not just the one who happened to be viewing.
        // Only INSERTs of the NEW_BOOKING type toast — reads/updates stay silent.
        //
        // This is a BACKGROUND alert: the admin did not click anything to cause
        // it. It therefore goes through `toastManager.background`, which (a)
        // suppresses it entirely while a modal is open — so it can never cover
        // the Official Receipt or a confirmation dialog — and (b) counts toward
        // the shared 2-toast cap, so it cannot stack on top of the toast the
        // admin's own action just produced.
        if (payload?.eventType === 'INSERT' && payload?.new?.notification_type === 'NEW_BOOKING') {
          const bookingId = payload.new.booking_id;
          toastManager.background(
            (t) => (
              <NotificationToast
                title={payload.new.message || 'New booking received.'}
                description="A customer just booked an appointment."
                actionLabel="View booking"
                onAction={() => { navigate(`/admin/bookings/${bookingId}`); toastManager.dismiss(t.id); }}
                onClose={() => toastManager.dismiss(t.id)}
              />
            ),
            { duration: 6000, kind: 'default', dedupeKey: `new-booking:${bookingId}` }
          );
        }
    });

    return () => {
      window.removeEventListener('notificationsRead', handleNotificationsRead);
      stopRealtime();
    };
  }, [user?.id, fetchUnreadCount, navigate]);

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    if (isMobile) setIsSidebarOpen(false);
  }, [location, isMobile]);

  const handleLogout = () => {
    confirmLogout(openModal, async () => {
      // 1. Close any active modal first to prevent UI flashes
      if (typeof closeModal === 'function') {
        closeModal();
      }

      // 2. Sign out and go straight to the next page
      await signOut('/staff/login');
    });
  };

  const navGroups = [
    {
      name: 'Core Operations',
      links: [
        { name: 'Dashboard', path: '/admin', icon: NAV_ICONS.dashboard, exact: true },
        { name: 'Business Hub', path: '/admin/business', icon: NAV_ICONS.business },
        { name: 'Booking Management', path: '/admin/bookings', icon: NAV_ICONS.bookings },
        { name: 'Calendar', path: '/admin/schedule', icon: NAV_ICONS.calendar },
        { name: 'New Walk-In', path: '/admin/walk-in', icon: NAV_ICONS.walkIn },
        { name: 'Message Inquiries', path: '/admin/chat', icon: NAV_ICONS.messages, badge: true }
      ]
    },
    {
      name: 'Finance',
      links: [
        { name: 'Payment Verification', path: '/admin/payments', icon: NAV_ICONS.paymentVerification },
        { name: 'Refund Hub', path: '/admin/refunds', icon: NAV_ICONS.refunds },
        { name: 'Receipts & Proofs', path: '/admin/receipts', icon: NAV_ICONS.receipts },
        { name: 'Reports', path: '/admin/reports', icon: NAV_ICONS.reports }
      ]
    },
    {
      name: 'System & Admin',
      links: [
        { name: 'Audit Logs', path: '/admin/audit-logs', icon: NAV_ICONS.history },
        { name: 'Backups', path: '/admin/backups', icon: NAV_ICONS.backups },
        { name: 'Staff Roles', path: '/admin/accounts', icon: NAV_ICONS.staff },
        { name: 'Client Directory', path: '/admin/users', icon: NAV_ICONS.clients },
        { name: 'Notifications', path: '/admin/notifications', icon: NAV_ICONS.notifications }
      ]
    }
  ];

  const BlurGlow = ({ top, left, right, bottom, size, color }) => (
    <div style={{
      position: 'absolute',
      top, left, right, bottom,
      width: size,
      height: size,
      background: color || 'rgba(196, 31, 43, 0.4)',
      filter: 'blur(120px)',
      borderRadius: '50%',
      zIndex: 0,
      pointerEvents: 'none',
      opacity: 0.4
    }} />
  );

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
    transition: 'left 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
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
    <div className="admin-theme admin-account-theme" data-theme={resolvedTheme} style={{ display: 'flex', width: '100vw', height: '100vh', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', position: 'relative', overflow: 'hidden' }}>

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
            <h1 style={{ fontSize: '1.25rem', fontWeight: '950', margin: 0, fontStyle: 'italic', letterSpacing: '1px', color: 'var(--admin-text-primary)' }}>
              COMAR GARAGE <span style={{ color: 'var(--admin-brand)' }}>ADMIN</span>
            </h1>
            {isMobile && <button onClick={() => setIsSidebarOpen(false)} style={{ color: 'var(--admin-text-primary)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>}
          </div>
          <p style={{ fontSize: '0.6rem', color: 'var(--admin-text-secondary)', fontWeight: '900', marginTop: '0.4rem', textTransform: 'uppercase', letterSpacing: '2px', opacity: 0.8 }}>
            Command & Control Center
          </p>
        </div>

        <nav data-tour="admin-nav" style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 0.5rem' }}>
          {navGroups.map((group, groupIndex) => (
            <div key={group.name} style={{ marginTop: groupIndex === 0 ? 0 : '1rem' }}>
              <div style={{ padding: '0.5rem 1rem', color: 'var(--admin-text-secondary)', fontSize: '0.65rem', fontWeight: '700', letterSpacing: '0.04em', opacity: 0.75 }}>
                {group.name}
              </div>
              {group.links.map((link) => (
                <SidebarLink
                  key={link.name}
                  to={link.path}
                  end={link.exact}
                  icon={link.icon}
                  badge={link.badge && globalUnreadCount > 0 ? (globalUnreadCount > 99 ? '99+' : globalUnreadCount) : null}
                  badgeLabel={link.badge ? `${globalUnreadCount} unread messages` : undefined}
                >
                  {link.name}
                </SidebarLink>
              ))}
            </div>
          ))}
        </nav>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', padding: '1rem 0.5rem', borderTop: '1px solid var(--admin-border)' }}>
          <SidebarLink to="/admin/settings" icon={NAV_ICONS.settings}>Settings</SidebarLink>

          <SidebarButton icon={NAV_ICONS.logout} onClick={handleLogout}>Log out</SidebarButton>
        </div>
      </aside>

      <div className="admin-main-wrapper" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', maxWidth: '100%', height: '100vh', overflow: 'hidden', marginLeft: isMobile ? 0 : (isDesktopCollapsed ? 0 : '260px'), transition: 'margin-left 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }}>
        <header className="no-print" style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: isMobile ? '0.6rem 1rem' : '0.75rem 2.5rem',
          borderBottom: '1px solid var(--admin-border)',
          background: 'var(--admin-card)',
          position: 'sticky',
          top: 0,
          zIndex: 50,
          boxShadow: 'var(--admin-card-shadow)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '1rem' : '1.5rem' }}>
            <button
              type="button"
              onClick={toggleSidebar}
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
              style={{ color: 'var(--admin-text-primary)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '0.4rem', borderRadius: 'var(--admin-radius-sm)' }}
            >
              <Menu size={20} />
            </button>
            <div
              style={{ fontSize: isMobile ? '0.9rem' : '1.1rem', fontWeight: '950', letterSpacing: '1px', cursor: 'pointer', color: 'var(--admin-text-primary)', textTransform: 'uppercase' }}
              onClick={() => navigate('/admin')}
            >
              Admin Account
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '0.5rem' : '0.75rem', position: 'relative' }}>
            <AdminSearch />
            <button
              type="button"
              className="admin-header-icon"
              onClick={() => setShowNotifPopover(!showNotifPopover)}
              aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
              aria-expanded={showNotifPopover}
              data-active={showNotifPopover || undefined}
            >
              <Bell size={18} strokeWidth={2.25} />
              {unreadCount > 0 && (
                <span aria-hidden="true" style={{
                  position: 'absolute',
                  top: '2px',
                  right: '0px',
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
                  borderRadius: '2px', // SHARP BADGE
                  border: '1px solid var(--admin-card)',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                }}>{unreadCount}</span>
              )}
            </button>

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
              roleTitle="Administrator"
              profilePath="/admin/profile"
              settingsPath="/admin/settings"
              onLogoutClick={handleLogout}
            />
          </div>
        </header>

        <main style={{ flex: 1, minHeight: 0, padding: isMobile ? '1.5rem 1rem' : '2.5rem', overflowY: 'auto', scrollPaddingTop: 'var(--app-shell-header-height)', background: 'var(--admin-bg)' }}>
          <Outlet />
        </main>
        <TermsGate />
        <LanguageGate />
      </div>
      {/* Shortcut to the same conversations the Chat page lists. */}
      {location.pathname !== '/admin/chat' && <FloatingBubbleChat />}
    </div>
  );
};

export default AdminLayout;
