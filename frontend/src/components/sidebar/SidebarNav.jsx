import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  BadgeCheck, BellRing, Building2, Calendar, CalendarPlus, Car, ClipboardList, Clock, CreditCard, DoorOpen, History, LayoutGrid, LineChart, LogOut, MessageSquare, Receipt, Settings, Undo2, UserCog, Users,
  DatabaseBackup
} from 'lucide-react';

/**
 * The side panel's items, shared by the admin, staff and customer layouts so all three look and behave the same.
 *
 * NAV_ICONS gives each kind of page ONE Lucide icon (the icon set shadcn/ui uses), whichever account type shows it:
 * every list of bookings or jobs is a checklist, every report a line chart, every history the history clock.
 * Styling lives in index.css (.sidebar-link): no side line, no lift or shadow on hover, one icon size and stroke.
 */
export const NAV_ICONS = {
  dashboard: LayoutGrid,
  business: Building2,
  bookings: ClipboardList,
  calendar: Calendar,
  newBooking: CalendarPlus,
  walkIn: DoorOpen,
  messages: MessageSquare,
  paymentVerification: BadgeCheck,
  refunds: Undo2,
  receipts: Receipt,
  reports: LineChart,
  history: History,
  backups: DatabaseBackup,
  staff: UserCog,
  clients: Users,
  notifications: BellRing,
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
