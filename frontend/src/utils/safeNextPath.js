/**
 * Where to send someone after they sign in, taken from the ?next= address that
 * the email buttons and the route guard add (for example
 * /login?next=/customer/bookings/<id>).
 *
 * Only a path inside THIS site, under the area their role may open, is honoured;
 * anything else (another website, a protocol-relative //host address, a path for
 * a different role) is ignored and the normal role home is used instead.
 */
const ROLE_AREAS = { ADMIN: '/admin', STAFF: '/staff', CUSTOMER: '/customer' };

export const safeNextPath = (next, role) => {
  const value = String(next || '').trim();
  const area = ROLE_AREAS[String(role || '').toUpperCase()];
  if (!value || !area) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return null;
  return value === area || value.startsWith(area + '/') || value.startsWith(area + '?') ? value : null;
};
