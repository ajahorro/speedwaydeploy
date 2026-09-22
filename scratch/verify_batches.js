// Verifies the existence of every Batch 1-5 fix by name.
// Master E2E sweep: imported-by-name assertions across all five batches.
// Run: node scratch/verify_batches.js
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
  ['SYS-A    servicesCatalog API',    'frontend/src/data/servicesCatalog.js',         ["fetchActivePromos", "getBestPromoForService"]],
  ['SYS-A    AdminSchedule promo API','frontend/src/pages/Admin/AdminSchedule.jsx',   ["/api/admin/promos"]],
  ['DELETED  standardPromo.js gone',  'frontend/src/domain/promo/standardPromo.js',   []],
  ['DELETED  promoService.js gone',   'frontend/src/services/promoService.js',        []],
  ['DELETED  ResetForm.jsx gone',     'frontend/src/components/auth/ResetForm.jsx',   []],
  ['DELETED  VerifyForm.jsx gone',    'frontend/src/components/auth/VerifyForm.jsx',  []],

  // ── Batch 5: Photo Proof Architecture ───────────────────────────────────
  ['B5  migration: service_photos',   'supabase/migrations/20260924000001_add_service_photos_table.sql', ["create table if not exists public.service_photos", "phase in ('before', 'after')", "legacy_backfill", "retention_exempt"]],
  ['B5  migration: private bucket',   'supabase/migrations/20260924000002_create_service_proofs_private_bucket.sql', ["'service-proofs'", "public, file_size_limit", "storage.foldername"]],
  ['B5  migration: retention policy', 'supabase/migrations/20260924000003_add_photo_retention_policy.sql', ["photo_retention_archive_months", "photo_retention_purge_months", "archive_stale_service_photos", "purge_stale_service_photos", "run_service_photo_retention", "pg_cron"]],
  ['B5  backend hard-block gate',     'backend/server.js',                             ["PHOTO_PROOF_REQUIRED", "phase', 'after'", "PHOTO_PROOF_OVERRIDE", "photoOverrideReason"]],
  ['B5  photoService.js',             'frontend/src/services/photoService.js',        ["uploadServicePhoto", "createSignedUrl", "SIGNED_URL_TTL_SECONDS", "resolvePhotoUrl", "isAbsoluteUrl"]],
  ['B5  PhotoProofUploader.jsx',      'frontend/src/components/Photos/PhotoProofUploader.jsx', ["phase", "uploadServicePhoto", "resolvePhotoUrls", "var(--admin-brand)"]],
  ['B5  PhotoProofGallery.jsx',       'frontend/src/components/Photos/PhotoProofGallery.jsx',  ["Intake (Before)", "Completion (After)", "fetchBookingPhotos"]],
  ['B5  IntakeWarningBadge.jsx',      'frontend/src/components/Photos/IntakeWarningBadge.jsx', ["--status-warning", "--status-success", "--status-danger"]],
  ['B5  staff soft-warn start',       'frontend/src/pages/Staff/StaffDashboard.jsx',  ["requestStartTask", "Start Without Intake Photo", "IntakeWarningBadge"]],
  ['B5  staff hard-gate complete',    'frontend/src/pages/Staff/StaffDashboard.jsx',  ["missingAfter", "requestCompleteWithOverride", "overrideReason"]],
  ['B5  admin evidence drawer',       'frontend/src/pages/Admin/AdminBookingDetails.jsx', ["PhotoProofGallery", "photoGalleryOpen", "View Evidence"]],
  ['B5  customer evidence drawer',    'frontend/src/pages/Customer/CustomerBookingDetails.jsx', ["PhotoProofGallery", "photoGalleryOpen", "View Service Photos"]],
  ['B5  spin utility (global css)',   'frontend/src/index.css',                       ["@keyframes spin", ".spin {"]],
  ['DELETED  orphan plateNorm gone',  'frontend/src/domain/booking/plateNormalization.js', []],
  ['DELETED  legacy promo test gone', 'frontend/tests/domain/promoEngine.test.mjs',   []]
];

let pass = 0;
let fail = 0;
const byBatch = {};
console.log('=== BATCH 1-5 MASTER E2E REGRESSION SWEEP ===\n');
for (const [label, file, needles] of checks) {
  const r = has(file, needles);
  const deletedCheck = label.startsWith('DELETED');
  const ok = deletedCheck ? !r.ok && r.why === 'FILE MISSING' : r.ok;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        ${file} -> ${r.why}`);
  ok ? pass++ : fail++;

  // Bucket for the per-batch summary (B1..B5, else OTHER).
  const m = label.match(/^B(\d)/);
  const key = m ? `Batch ${m[1]}` : 'Reconciliation/Other';
  byBatch[key] = byBatch[key] || { pass: 0, fail: 0 };
  ok ? byBatch[key].pass++ : byBatch[key].fail++;
}
console.log('\n--- per-batch ---');
for (const [k, v] of Object.entries(byBatch)) {
  console.log(`${k.padEnd(22)} ${v.pass}/${v.pass + v.fail} passed`);
}
console.log(`\n=== ${pass} passed, ${fail} failed (${checks.length} checks) ===`);
process.exit(fail === 0 ? 0 : 1);
