import { BACKEND_URL } from '../config/api';

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const resolveBookingId = async (client, reference) => {
  const value = String(reference || '').trim();
  if (!value) return null;
  if (UUID_PATTERN.test(value)) return value;

  const compactReference = value.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{8,32}$/.test(compactReference)) {
    const minHex = compactReference.padEnd(32, '0');
    const maxHex = compactReference.padEnd(32, 'f');
    const formatUuid = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const { data, error } = await client
      .from('bookings')
      .select('id')
      .gte('id', formatUuid(minHex))
      .lte('id', formatUuid(maxHex))
      .limit(2);
    if (error) throw error;
    if (data?.length === 1) return data[0].id;
    if (data?.length > 1) throw new Error('The booking reference is ambiguous.');
  }

  const { data, error } = await client
    .from('bookings')
    .select('id')
    .eq('booking_id', value)
    .maybeSingle();
  if (error) throw error;
  return data?.id || null;
};

export const resolveStaffJobId = async (client, bookingReference) => {
  const bookingId = await resolveBookingId(client, bookingReference);
  if (!bookingId) return null;

  const bookings = await fetchStaffBookings(client, { bookingId });
  const units = bookings.flatMap((booking) => booking.vehicles || []);
  const priority = { IN_PROGRESS: 0, PENDING: 1, SCHEDULED: 2, CONFIRMED: 3 };
  units.sort((a, b) =>
    (priority[String(a.status || '').toUpperCase()] ?? 4)
      - (priority[String(b.status || '').toUpperCase()] ?? 4)
  );
  return units[0]?.id || null;
};

export const fetchStaffBookings = async (client, filters = {}) => {
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.access_token) throw new Error('Your staff session has expired. Please sign in again.');

  const query = new URLSearchParams();
  if (filters.bookingId) query.set('bookingId', filters.bookingId);
  if (filters.vehicleId) query.set('vehicleId', filters.vehicleId);

  const response = await fetch(`${BACKEND_URL}/api/staff/tasks?${query.toString()}`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${session.access_token}` }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Could not load assigned work.');
  }
  return result.bookings || [];
};

export const isRedundantStaffTechnicianAssignment = (notification) => {
  if (!notification) return false;
  const title = String(notification.title || '').trim().toLowerCase();
  const type = String(notification.notification_type || '').trim().toUpperCase();
  return type === 'ASSIGNMENT' && /^technician assignment$/.test(title);
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
