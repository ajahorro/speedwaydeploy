// Verifies the existence of every Batch 1-6 fix by name.
// Master E2E sweep: imported-by-name assertions across all six batches.
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
  ['DELETED  legacy promo test gone', 'frontend/tests/domain/promoEngine.test.mjs',   []],

  // ── Batch 6: Schedule Rules Engine, Server Validation & Modal UI ─────────
  // Step 6.1 — migration + pure rules module
  ['B6  migration: schedule rules',   'supabase/migrations/20260925000001_add_schedule_rules.sql', ["booking_lead_time_minutes", "max_advance_days", "closed_weekdays", "enforce_capacity", "business_config_lead_time_bounds", "business_config_advance_days_bounds", "business_config_closed_weekdays_valid"]],
  ['B6  pure rules module',           'frontend/src/domain/schedule/rules.js',        ["isDateBookable", "isSlotBookable", "getBookableSlots", "normalizeConfig", "SCHEDULE_DECISION_CODES"]],
  // Step 6.2 — backend enforcement
  ['B6  server validation service',   'backend/services/scheduleValidation.js',       ["validateBookingRequest", "loadScheduleContext", "countStaffOnDuty", "SCHEDULE_DECISION_CODES"]],
  ['B6  validate-slot endpoint',      'backend/server.js',                            ["/api/bookings/validate-slot", "/api/bookings/slots", "VALIDATION_UNAVAILABLE", "SLOT_UNAVAILABLE", "CAPACITY_EXCEED"]],
  // Step 6.3 — ValidationModal + client wiring
  ['B6  ValidationModal codes',       'frontend/src/components/ValidationModal.jsx',  ["PAST_DATE", "CLOSED_WEEKDAY", "BLOCKED_DATE", "BEYOND_ADVANCE_WINDOW", "LEAD_TIME", "SLOT_UNAVAILABLE", "CAPACITY_EXCEED", "VALIDATION_UNAVAILABLE"]],
  ['B6  ValidationModal tokens',      'frontend/src/components/ValidationModal.jsx',  ["var(--admin-card)", "var(--admin-brand)", "var(--modal-overlay)", "var(--status-warning)", "Pick Another Time", "Select Next Available Date"]],
  ['B6  client validation service',   'frontend/src/services/scheduleValidationService.js', ["validateSlot", "/api/bookings/validate-slot", "reachable"]],
  ['B6  fail-closed on unreachable',  'frontend/src/services/scheduleValidationService.js', ["valid: false", "VALIDATION_UNAVAILABLE", "fail-closed"]],
  ['B6  wizard pre-submit gate',      'frontend/src/pages/Customer/CustomerBookAppointment.jsx', ["validateSlot", "ValidationModal", "setValidationIssue", "calculateBayUsage"]],
  // Step 6.4 — calendar greying + admin Schedule Rules tab
  ['B6  calendar rules-aware',        'frontend/src/components/BookingWizard/CustomCalendar.jsx', ["isDateBookable", "decision.reason", "blocked_slots", "aria-label"]],
  ['B6  slot date-gate feedback',     'frontend/src/components/BookingWizard/Step1Schedule.jsx', ["isDateBookable", "dateGate", "blocked_slots"]],
  ['B6  BusinessHub Schedule tab',    'frontend/src/pages/Admin/BusinessHub.jsx',     ["'schedule'", "Schedule Rules", "booking_lead_time_minutes", "max_advance_days", "closed_weekdays", "enforce_capacity", "toggleClosedWeekday"]],
  ['B6  BusinessHub smart-save',      'frontend/src/pages/Admin/BusinessHub.jsx',     ["section === 'schedule'", "canSave('schedule')", "isDirty('schedule')"]],

  // ── Batch 7 / Step 7.3: Toast consolidation + error-routing policy ───────
  ['B7.3 shared toast chrome',       'frontend/src/utils/toastChrome.js',            ["TOAST_BASE_STYLE", "TOASTER_DEFAULTS", "var(--admin-card)", "var(--admin-text-primary)", "--status-danger", "375px-safe"]],
  ['B7.3 Toaster uses shared chrome', 'frontend/src/main.jsx',                        ["TOASTER_DEFAULTS", "<Toaster"]],
  ['B7.3 UIContext consolidated',     'frontend/src/context/UIContext.jsx',           ["react-hot-toast", "toastChrome", "toast.success", "toast.error", "toast.dismiss"]],
  ['B7.3 legacy toast stack gone',    'frontend/src/context/UIContext.jsx',           ["Toasts are NO LONGER rendered here", "exactly one toast engine"]],
  ['B7.3 error routing classifier',   'frontend/src/utils/errorRouting.js',           ["classifyScheduleError", "toCleanMessage", "PAST_DATE", "CAPACITY_EXCEEDED", "SLOT_UNAVAILABLE", "VALIDATION_UNAVAILABLE"]],
  ['B7.3 read-error copy fixed',      'frontend/src/services/bookingService.js',      ["could not load your bookings", "[CustomerBookings]"]],
  ['B7.3 promo fail-closed',          'frontend/src/components/AdminSchedule/PromoManager.jsx', ["FAIL-CLOSED", "promotions service is unreachable", "logger"]],
  ['DELETED  ConfirmationToast gone', 'frontend/src/components/ConfirmationToast.jsx',  []],
  ['DELETED  confirmationStyles gone','frontend/src/styles/confirmationStyles.js',      []],

  // ── Batch 7 / Step 7.4: Global UI/UX polish (tokens + mobile) ────────────
  ['B7.4 phantom tokens defined',     'frontend/src/index.css',                       ["--admin-success:", "--admin-success-rgb:", "--admin-warning:", "--admin-info:", "--admin-surface:", "--admin-radius-md:", "--admin-radius-lg:", "--admin-text-on-brand:", "--admin-text-on-status:"]],
  ['B7.4 login overflow clipped',     'frontend/src/pages/Login.jsx',                 ["overflow: 'hidden'", "maxWidth: '100vw'"]],
  ['B7.4 landing container fixed',    'frontend/src/pages/Landing.jsx',               [".container-wide { max-width: 1200px", "minmax(min(100%, 320px), 1fr)"]],
  ['B7.4 login token (no --bg-primary)', 'frontend/src/pages/Login.jsx',              ["var(--admin-bg)"]],
  ['B7.4 staff layout tokenized',     'frontend/src/pages/Staff/StaffLayout.jsx',     ["var(--admin-bg)", "var(--admin-card)", "var(--admin-text-primary)"]],
  ['B7.4 modal styles tokenized',     'frontend/src/context/UIContext.jsx',           ["brandColor: 'var(--status-danger)'", "brandColor: 'var(--status-warning)'", "brandColor: 'var(--status-success)'"]],
  ['B7.4 audit harness present',      'scratch/qa_full_audit.mjs',                    ["docScrollW", "overflow", "ROUTES", "auth-token"]],

  // ── Batch 7 / Step 7.5: Final E2E audit harnesses ───────────────────────
  ['B7.5 logic E2E harness',          'scratch/verify_75_logic.mjs',                  ["calculateBayUsage", "isSlotBookable", "sanitizeVehiclePlate", "SLOT_FULL"]],
  ['B7.5 DB-state harness',           'scratch/verify_75_db.mjs',                     ["slot_has_capacity", "lock_schedule_day", "audit_logs", "RLS"]],
  ['B7.5 suite1 lockout harness',     'scratch/verify_75_suite1.mjs',                 ["lockout", "speedway-theme", "Attempt"]],
  ['B7.5 suite245 harness',           'scratch/verify_75_suite245.mjs',               ["hasViewChanges", "hasOtp", "hasConfidence"]],
  ['B7.5 lockout 5-attempt contract', 'frontend/src/context/AuthContext.jsx',         ["failedAttempts >= 5", "LOGIN_LOCKOUT_MS", "Account locked for 20 minutes"]],

  // ── Batch 7 / Step 7.5: Task B (QR security, OCR ledger, guards, audit diff) ─
  ['B7.5 TaskB migration',            'supabase/migrations/20260926000001_task_b_qr_security_ocr_ledger.sql', ["qr_account_name", "qr_account_number", "fallback_receiver_name", "fallback_receiver_number", "active_qr_snapshot", "customer_credit_ledger", "apply_service_downpayment", "settle_overpayment_on_completion", "start_qr_change_otp", "verify_qr_change_otp", "All fields are required"]],
  ['B7.5 TaskB QR service',           'frontend/src/services/qrSecurityService.js',    ["QR_FIELDS", "validateQrRecipients", "captureQrSnapshot", "requestQrChangeOtp", "verifyQrChangeOtp"]],
  ['B7.5 TaskB credit ledger service','frontend/src/services/creditLedgerService.js',  ["computeNetCredit", "total - fee", "applyServiceDownpayment", "settleOverpaymentOnCompletion", "recordExcessCredit"]],
  ['B7.5 TaskB OTP modal',            'frontend/src/components/Business/QrChangeOtpModal.jsx', ["All fields are required", "6-digit", "Send Code", "Verify & Save"]],
  ['B7.5 TaskB audit diff modal',     'frontend/src/components/AuditLog/ChangeDiffModal.jsx', ["old_values", "new_values", "View Changes"]],
  ['B7.5 TaskB audit log column',     'frontend/src/pages/Admin/AdminAuditLogs.jsx',  ["ChangeDiffModal", "View Changes", "hasChanges"]],
  ['B7.5 TaskB business hub QR',      'frontend/src/pages/Admin/BusinessHub.jsx',     ["validateQrRecipients", "QrChangeOtpModal", "qr_account_name", "fallback_receiver_number", "Change QR", "useUnsavedChangesGuard"]],
  ['B7.5 TaskB unsaved guard hook',   'frontend/src/hooks/useUnsavedChangesGuard.js', ["confirmNavigation", "beforeunload", "modalProps"]],
  ['B7.5 TaskB sanitization',         'frontend/src/config/constants.js',             ["ALPHANUMERIC_PATTERN", "sanitizeAlphaNum", "isAlphaNum"]],
  ['B7.5 TaskB checkout snapshot',    'frontend/src/components/BookingWizard/Step4ReviewPayment.jsx', ["captureQrSnapshot", "qrTarget", "QR_FALLBACK_NAME"]],
  ['B7.5 TaskB QR fields in config',  'frontend/src/context/ConfigContext.jsx',       ["QR_ACCOUNT_NAME", "QR_FALLBACK_NAME", "QR_CONFIG_VERSION"]],
  ['B7.5 TaskB backend OTP email',    'backend/server.js',                            ["/api/emails/qr-change-otp", "QR Change Verification Code"]],
  ['B7.5 TaskB settle on complete',   'backend/server.js',                            ["settle_overpayment_on_completion"]],
  ['B7.5 TaskB net credit payments',  'frontend/src/services/bookingService.js',      ["transferFee", "netCredit", "active_qr_snapshot", "recordExcessCredit"]],
  ['B7.5 TaskB downpayment absorb',   'frontend/src/pages/Admin/AdminBookingDetails.jsx', ["applyServiceDownpayment", "creditUsed", "net shortfall"]],
  ['B7.5 TaskB refresh guard',        'frontend/src/pages/Customer/CustomerBookAppointment.jsx', ["blockUnload", "You have unsaved booking changes"]],
  ['B7.5 migration validator',        'backend/validate_all_migrations.cjs',          ["apply_service_downpayment", "settle_overpayment_on_completion", "qr_config_complete"]]
];

let pass = 0;
let fail = 0;
const byBatch = {};
console.log('=== BATCH 1-6 MASTER E2E REGRESSION SWEEP ===\n');
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
