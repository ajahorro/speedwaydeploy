// Guardrails for the Part 2 email and account-detail rules. Run:
//   node scripts/verify-email-links.mjs
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const bookingEmail = read('supabase/functions/_shared/bookingEmail.ts');
const lifecycle = read('supabase/functions/booking-lifecycle/index.ts');
const notificationEmail = read('supabase/functions/send-notification-email/index.ts');
const backend = read('backend/server.js');
const syncMigration = read('supabase/migrations/20261031000001_customer_details_sync_and_invites.sql');
const registerForm = read('frontend/src/components/auth/RegisterForm.jsx');
const protectedRoute = read('frontend/src/components/ProtectedRoute.jsx');

const checks = [
  ['links: every email button reads VIEW BOOKING DETAILS',
    !/VIEW IN PORTAL|VIEW RECEIPT IN PORTAL|CREATE ACCOUNT TO VIEW BOOKING/.test(bookingEmail + notificationEmail)
    && /VIEW BOOKING DETAILS/.test(bookingEmail) && /VIEW BOOKING DETAILS/.test(notificationEmail)],
  ['links: the site address comes from one setting, not scattered literals',
    /export const siteUrl/.test(bookingEmail) && (bookingEmail.match(/https:\/\/comargarage\.com/g) || []).length === 1],
  ['links: account holders go to login with a return path, walk-ins to registration with an invite',
    /login\?next=/.test(lifecycle) && /create_guest_registration_invite/.test(lifecycle) && /register=1&invite=/.test(lifecycle)],
  ['links: notification emails use a full address through sign-in, not a bare path',
    /login\?next=\$\{encodeURIComponent\(actionPath\)\}/.test(notificationEmail)],
  ['receipts: a confirmation or creation email carries the receipt of the newest paid payment (downpayment included)',
    /paidTransactions\[paidTransactions\.length - 1\]/.test(lifecycle)
    && /'payment_verified', 'booking_confirmed', 'booking_created'/.test(lifecycle)],
  ['receipts: a payment taken with an added service emails its receipt',
    /ADDED_SERVICE:\$\{serviceName\}/.test(backend) && /event: 'payment_verified', paymentId \}/.test(backend)],
  ['reminder: skipped when the booking was made or confirmed inside the last hour; marked sent only when delivered',
    /madeInsideLastHour/.test(backend) && /confirmedInsideLastHour/.test(backend)
    && /Only a reminder that really went out is marked as sent/.test(backend)],
  ['reminder: walk-ins without an account are reminded through the booking email address',
    /booking\.customer_email \|\| booking\.customer\?\.email/.test(backend)],
  ['account details: open bookings follow the account, finished ones are never touched, each change is audited',
    /not public\.booking_is_terminal\(status\)/.test(syncMigration) && /CUSTOMER_DETAILS_UPDATED/.test(syncMigration)],
  ['account details: invites last 7 days and are single-use',
    /interval '7 days'/.test(syncMigration) && /used_at is null/.test(syncMigration)],
  ['registration: only the email is locked when a booking invite pre-fills the form',
    /readOnly=\{lockEmail\}/.test(registerForm) && !/readOnly=\{isPrefilled\}/.test(registerForm) && !/isPrefilled/.test(registerForm)],
  ['sign-in: a guarded page sends signed-out visitors to login with ?next=',
    /login\?next=/.test(protectedRoute)]
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
