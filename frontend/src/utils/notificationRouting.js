export const normalizeRole = (role) => {
  const normalized = String(role || '').trim().toUpperCase();

  if (normalized === 'ADMIN') return 'ADMIN';
  if (normalized === 'STAFF') return 'STAFF';
  return 'CUSTOMER';
};

export const roleToRoutePrefix = (role) => {
  const normalized = normalizeRole(role);

  if (normalized === 'ADMIN') return '/admin';
  if (normalized === 'STAFF') return '/staff';
  return '/customer';
};

export const buildNotificationActionUrl = ({ bookingId, role, isChatMessage = false }) => {
  if (!bookingId) return null;

  const prefix = roleToRoutePrefix(role);
  const url = `${prefix}/bookings/${bookingId}`;
  return isChatMessage ? `${url}?chat=open` : url;
};

const BOOKING_CONTEXT_NOTIFICATION_TYPES = new Set([
  'CHAT_MESSAGE',
  'MESSAGE_RECEIVED',
  'STATUS_UPDATE',
]);

export const isNotificationActionable = (notification) => {
  if (!notification) return false;
  const type = String(notification.notification_type || '').toUpperCase();
  return !BOOKING_CONTEXT_NOTIFICATION_TYPES.has(type) || Boolean(notification.booking_id);
};
