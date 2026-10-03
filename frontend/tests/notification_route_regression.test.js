import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNotificationActionUrl, resolveStaffJobId } from '../src/utils/notificationRouting.js';

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

test('staff notification links resolve booking references through the staff endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;

  globalThis.fetch = async (url, options) => {
    requestedUrl = new URL(url, 'http://localhost');
    assert.equal(options.headers.Authorization, 'Bearer staff-access-token');
    return {
      ok: true,
      json: async () => ({
        success: true,
        bookings: [{
          vehicles: [
            { id: 'vehicle-2', status: 'SCHEDULED' },
            { id: 'vehicle-1', status: 'IN_PROGRESS' }
          ]
        }]
      })
    };
  };

  try {
    const jobId = await resolveStaffJobId({
      auth: { getSession: async () => ({ data: { session: { access_token: 'staff-access-token' } }, error: null }) },
      from: () => { throw new Error('Staff lookup must not query bookings through the browser client.'); }
    }, 'BOOK-123');

    assert.equal(jobId, 'vehicle-1');
    assert.equal(requestedUrl.searchParams.get('bookingId'), 'BOOK-123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
