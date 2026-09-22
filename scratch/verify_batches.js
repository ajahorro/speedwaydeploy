// Verifies the existence of every Batch 1-4 fix by name.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};
const has = (rel, needles) => {
  const src = read(rel);
  if (src === null) return { ok: false, why: 'FILE MISSING' };
  const missing = needles.filter(n => !src.includes(n));
  return { ok: missing.length === 0, why: missing.length ? 'missing: ' + missing.join(', ') : '' };
};

const checks = [
  ['B1  walk-in auto-confirm',        'frontend/src/services/bookingService.js',      ["isAdminWalkIn", "initialBookingStatus", "? 'confirmed' : 'scheduled'"]],
  ['B1  walk-in PAID bypass',         'frontend/src/pages/Admin/AdminWalkInWizard.jsx', ["adminWalkIn: true", "status: 'PAID'"]],
  ['B1  email recipient fallback',    'supabase/functions/send-status-email/index.ts', ["customer_email", "booking.customer_name"]],
  ['B1  RESEND domain .xyz',          'supabase/functions/send-status-email/index.ts', ["speedway-autoxmoto.xyz"]],
  ['B1  RESEND domain .xyz (notif)',  'supabase/functions/send-notification-email/index.ts', ["speedway-autoxmoto.xyz"]],
  ['B1  backend VAT clamp',           'backend/server.js',                             ["Math.max(0"]],
  ['B2  refund sub-filters',          'frontend/src/pages/Admin/AdminRefunds.jsx',    ["methodFilter", "Payment Method", "'Digital', 'Cash'"]],
  ['B3  per-thread unread (context)', 'frontend/src/context/ChatContext.jsx',         ["threadUnread", "reportThreadUnread", "hasUnreadInThread"]],
  ['B3  per-thread unread (chat UI)', 'frontend/src/components/BookingChat.jsx',      ["reportThreadUnread"]],
  ['B3  Seen + read_at',              'frontend/src/components/BookingChat.jsx',      ["read_at", "Seen"]],
  ['B3  chat notification builder',   'frontend/src/services/eventEngine.js',         ["buildChatNotificationMessage", "MESSAGE_PREVIEW_CHARS"]],
  ['B3  chat notification parser',    'frontend/src/components/NotificationPopover.jsx', ["parseChatNotification"]],
  ['B3  chat deep-link opens panel',  'frontend/src/pages/Admin/AdminBookingDetails.jsx', ["useSearchParams", "openChatForBooking"]],
  ['B3  chat deep-link (customer)',   'frontend/src/pages/Customer/CustomerBookingDetails.jsx', ["useSearchParams", "openChatForBooking"]],
  ['B4  register dead-end fixed',     'frontend/src/hooks/useAuthFlow.js',            ["emailRedirectTo", "identities"]],
  ['B4  resendConfirmation',          'frontend/src/hooks/useAuthFlow.js',            ["resendConfirmation", "auth.resend"]],
  ['B4  AWAIT_LINK redirect guard',   'frontend/src/hooks/useAuthFlow.js',            ["mode !== 'AWAIT_LINK'"]],
  ['B4  email prefill',               'frontend/src/components/auth/RecoverForm.jsx', ["initialEmail"]],
  ['B4  copy: REQUEST A RESET LINK',  'frontend/src/components/auth/AuthHeader.jsx',  ["REQUEST A RESET LINK"]],
  ['B4  dead VERIFY/RESET removed',   'frontend/src/pages/Login.jsx',                 ["resendConfirmation"]],
  ['B4  reset link -> /password-confirmation', 'frontend/src/pages/Login.jsx',        ["/password-confirmation"]],
  ['RESTORED BusinessHub.jsx',        'frontend/src/pages/Admin/BusinessHub.jsx',     ["BusinessHub"]],
  ['INTACT   standardPromo.js',       'frontend/src/domain/promo/standardPromo.js',   ["validateStandardPromo", "applyStandardDiscount"]],
  ['DELETED  ResetForm.jsx gone',     'frontend/src/components/auth/ResetForm.jsx',   []],
  ['DELETED  VerifyForm.jsx gone',    'frontend/src/components/auth/VerifyForm.jsx',  []]
];

let pass = 0;
let fail = 0;
console.log('=== BATCH 1-4 FIX VERIFICATION ===\n');
for (const [label, file, needles] of checks) {
  const r = has(file, needles);
  const deletedCheck = label.startsWith('DELETED');
  const ok = deletedCheck ? !r.ok && r.why === 'FILE MISSING' : r.ok;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        ${file} -> ${r.why}`);
  ok ? pass++ : fail++;
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
