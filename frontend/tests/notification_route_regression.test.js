import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNotificationActionUrl } from '../src/utils/notificationRouting.js';

test('chat notifications use the correct role-aware deep link', () => {
  assert.equal(
    buildNotificationActionUrl({ bookingId: 'bkg_123', role: 'ADMIN', isChatMessage: true }),
    '/admin/bookings/bkg_123?chat=open'
  );

  assert.equal(
    buildNotificationActionUrl({ bookingId: 'bkg_123', role: 'CUSTOMER', isChatMessage: true }),
    '/customer/bookings/bkg_123?chat=open'
  );

  assert.equal(
    buildNotificationActionUrl({ bookingId: 'bkg_123', role: 'STAFF', isChatMessage: false }),
    '/staff/bookings/bkg_123'
  );
});
