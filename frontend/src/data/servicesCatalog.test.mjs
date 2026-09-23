import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFrozenServiceSnapshot, buildBookingServiceSnapshot, getServiceCatalog } from './servicesCatalog.js';

test('buildFrozenServiceSnapshot preserves a frozen booking-time record', () => {
  const snapshot = buildFrozenServiceSnapshot({
    id: 'custom_1',
    name: 'Premium Shine',
    price: 3500,
    durationMinutes: 90,
    description: 'VIP polishing',
  }, 'Sedan');

  assert.equal(snapshot.service_name, 'Premium Shine');
  assert.equal(snapshot.price, 3500);
  assert.equal(snapshot.duration_minutes, 90);
  assert.equal(snapshot.vehicle_type, 'Sedan');
  assert.equal(snapshot.service_id, 'custom_1');
  assert.equal(snapshot.snapshot_source, 'catalog');
});

test('buildBookingServiceSnapshot stores immutable booking-time service details', () => {
  const snapshot = buildBookingServiceSnapshot({
    id: 'custom_1',
    name: 'Premium Shine',
    price: 3500,
    durationMinutes: 90,
    description: 'VIP polishing',
  }, 'Sedan');

  assert.equal(snapshot.service_name, 'Premium Shine');
  assert.equal(snapshot.final_price, 3500);
  assert.equal(snapshot.duration_minutes, 90);
  assert.equal(snapshot.vehicle_type, 'Sedan');
  assert.equal(snapshot.service_id, 'custom_1');
  assert.ok(Array.isArray(snapshot.service_snapshot));
});

test('getServiceCatalog keeps only active custom services and respects vehicle assignment', () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const mockStorage = {
    getItem: () => JSON.stringify([
      { id: 'a', name: 'Live Service', price: 600, durationMinutes: 45, archived: false, vehicleType: 'SUV' },
      { id: 'b', name: 'Archived Service', price: 800, durationMinutes: 50, archived: true, vehicleType: 'Sedan' }
    ]),
    setItem: () => {},
  };
  globalThis.window = { localStorage: mockStorage };
  globalThis.localStorage = mockStorage;

  try {
    const catalog = getServiceCatalog();
    const customEntries = catalog['Custom Services'] || [];
    assert.equal(customEntries.length, 1);
    assert.equal(customEntries[0].name, 'Live Service');
    assert.equal(customEntries[0].prices.SUV, 600);
    assert.equal(customEntries[0].prices.Sedan, undefined);
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
});
