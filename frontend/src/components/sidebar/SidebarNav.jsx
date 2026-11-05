import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutGrid, Building2, ClipboardList, CalendarDays, CalendarPlus, UserPlus, MessageCircle,
  BadgeCheck, Undo2, BarChart2, History, Users, BookUser, Bell, CreditCard, Car, Clock, Settings, LogOut,
} from 'lucide-react';

/**
 * The side panel's items, shared by the admin, staff and customer layouts so all three look and behave the same.
 *
 * NAV_ICONS gives each kind of page ONE Lucide icon (the icon set shadcn/ui uses), whichever account type shows it:
 * every list of bookings or jobs is a clipboard, every report a bar chart, every history the history clock.
 * Styling lives in index.css (.sidebar-link): no side line, no lift or shadow on hover, one icon size and stroke.
 */
export const NAV_ICONS = {
  dashboard: LayoutGrid,
  business: Building2,
  bookings: ClipboardList,
  calendar: CalendarDays,
  newBooking: CalendarPlus,
  walkIn: UserPlus,
  messages: MessageCircle,
  paymentVerification: BadgeCheck,
  refunds: Undo2,
  reports: BarChart2,
  history: History,
  staff: Users,
  clients: BookUser,
  notifications: Bell,
  billing: CreditCard,
  garage: Car,
  duty: Clock,
  settings: Settings,
  logout: LogOut,
};

export const SIDEBAR_ICON_PROPS = { size: 16, strokeWidth: 2, 'aria-hidden': true, className: 'sidebar-link-icon' };

/** A page link in the side panel. `badge` is shown at the right edge (unread counts). */
export function SidebarLink({ to, icon: Icon, children, end = false, badge = null, badgeLabel, onClick }) {
  return (
    <NavLink to={to} end={end} onClick={onClick} className={({ isActive }) => `sidebar-link${isActive ? ' is-active' : ''}`}>
      {Icon && <Icon {...SIDEBAR_ICON_PROPS} />}
      <span className="sidebar-link-label">{children}</span>
      {badge !== null && badge !== undefined && badge !== false && (
        <span className="sidebar-link-badge" aria-label={badgeLabel}>{badge}</span>
      )}
    </NavLink>
  );
}

/** A side-panel action that is not a page (Log out). Same look as SidebarLink; turns brand red on hover. */
export function SidebarButton({ icon: Icon, children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="sidebar-link sidebar-link-action">
      {Icon && <Icon {...SIDEBAR_ICON_PROPS} />}
      <span className="sidebar-link-label">{children}</span>
    </button>
  );
}
