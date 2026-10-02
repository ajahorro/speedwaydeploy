import assert from 'node:assert/strict';
import fs from 'node:fs';

const adminBooking = fs.readFileSync('frontend/src/pages/Admin/AdminBookingDetails.jsx', 'utf8');
const customerBooking = fs.readFileSync('frontend/src/pages/Customer/CustomerBookingDetails.jsx', 'utf8');
const technicalDocumentation = /technical documentation/i;

const checks = [
  ['registered profile phone is preferred over booking-time contact snapshots', /registeredCustomerPhone\s*\|\|\s*bookingContactPhone/.test(adminBooking)],
  ['booking contact snapshots remain available when the registered profile has no phone', /booking\?\.contact_number \|\| booking\?\.customer_phone/.test(adminBooking)],
  ['phone label distinguishes registered profile number from booking contact fallback', /registeredCustomerPhone \? 'Registered Phone' : 'Booking Contact'/.test(adminBooking)],
  ['profile lookup failures are logged without hiding available booking contact fallback', /Could not load registered customer contact details/.test(adminBooking) && /Could not resolve customer profile by booking email/.test(adminBooking)],
  ['admin booking notes use the Staff Notes label', /Staff Notes/.test(adminBooking)],
  ['customer booking notes use the Staff Notes label', /Staff Notes/.test(customerBooking)],
  ['legacy Technical Documentation wording is removed from both booking views', !technicalDocumentation.test(adminBooking) && !technicalDocumentation.test(customerBooking)]
];

for (const [name, passed] of checks) {
  assert.ok(passed, name);
  console.log(`PASS  ${name}`);
}

console.log(`\n${checks.length} Phase 6 checks passed.`);
