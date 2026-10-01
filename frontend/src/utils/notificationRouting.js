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
