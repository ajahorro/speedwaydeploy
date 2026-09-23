import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBusinessConfigUpdatePayload,
  isMissingColumnError,
  stripUnsupportedBusinessConfigColumns,
} from './businessConfigPayload.js';

test('buildBusinessConfigUpdatePayload includes faqs when supported', () => {
  const payload = buildBusinessConfigUpdatePayload({
    business_name: 'Speedway Studio',
    contact_number: '09123456789',
    email_address: 'hello@example.com',
    business_address: 'Test Street',
    opening_hour: '08:00',
    closing_hour: '17:00',
    qr_account_name: 'Speedway Studio',
    qr_account_number: '09123456789',
    payment_qr_url: 'https://cdn.example.com/qr.png',
    qr_config_complete: true,
    slots_per_hour: 4,
    max_vehicles_per_staff: 2,
    booking_lead_time_minutes: 30,
    max_advance_days: 7,
    closed_weekdays: [0, 6],
    enforce_capacity: true,
    custom_services: [],
    vehicle_types: ['Sedan'],
    faqs: [{ id: 'faq_1', question: 'Q', answer: 'A' }],
  }, { supportsFaqs: true });

  assert.equal(payload.faqs.length, 1);
  assert.equal(payload.business_name, 'Speedway Studio');
});

test('stripUnsupportedBusinessConfigColumns removes unsupported fields only when the DB says they are missing', () => {
  const payload = buildBusinessConfigUpdatePayload({
    business_name: 'Speedway Studio',
    contact_number: '09123456789',
    email_address: 'hello@example.com',
    business_address: 'Test Street',
    opening_hour: '08:00',
    closing_hour: '17:00',
    qr_account_name: 'Speedway Studio',
    qr_account_number: '09123456789',
    payment_qr_url: 'https://cdn.example.com/qr.png',
    qr_config_complete: true,
    slots_per_hour: 4,
    max_vehicles_per_staff: 2,
    booking_lead_time_minutes: 30,
    max_advance_days: 7,
    closed_weekdays: [],
    enforce_capacity: true,
    custom_services: [],
    vehicle_types: ['Sedan'],
    faqs: [{ id: 'faq_1', question: 'Q', answer: 'A' }],
  }, {
    supportsFaqs: true,
    supportsCustomServices: true,
    supportsVehicleTypes: true,
  });

  const stripped = stripUnsupportedBusinessConfigColumns(payload, {
    message: "Could not find the 'vehicle_types' column of 'business_config' in the schema cache",
  });

  assert.equal(stripped.custom_services, payload.custom_services);
  assert.equal(stripped.faqs, payload.faqs);
  assert.equal(stripped.vehicle_types, undefined);
  assert.equal(stripped.business_name, 'Speedway Studio');
});

test('isMissingColumnError catches the schema-cache error shape', () => {
  const error = { message: "Could not find the 'faqs' column of 'business_config' in the schema cache" };
  assert.equal(isMissingColumnError(error, 'faqs'), true);
  assert.equal(isMissingColumnError({ message: 'other issue' }, 'faqs'), false);
});
