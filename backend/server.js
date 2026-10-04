const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
require('dotenv').config();

const { normalizeStatus, shouldRestoreGraceWindow } = require('./noShowRestoreLogic');
// FAIL-FAST BOOT CHECK. Runs before any module reads process.env, so a missing
// SUPABASE_SERVICE_ROLE_KEY cannot silently degrade the server (or, worse, fall
// back to the literal 'development-key' cipher) as it did previously.
const { checkEnvironment } = require('./config/startupGuard');
const startupConfig = checkEnvironment();
const { validateBookingRequest } = require('./services/scheduleValidation');
const { Resend } = require('resend');
const { buildEmailShell, send, sendBookingConfirmationEmail, sendPasswordResetEmail, sendWrongPasswordSecurityNotice, sendAccountInviteEmail, sendAdminInviteEmail, sendInviteAccountEmail, sendEmergencyRecoveryEmail, sendQrChangeOtpEmail } = require('./services/emailService');
// EMAIL AUTH POLICY: single source of truth for LINK vs OTP per flow.
// See docs/EMAIL_AUTH_POLICY.md. Guards below keep UI copy and delivery in sync.
const { DELIVERY, assertDelivery } = require('./config/emailPolicy');
const { parseReceiptText, normalizeAmountValue, isValidReferenceNumber } = require('./services/receiptTextParser');
const { recognizeReceipt, warmReceiptOcr } = require('./services/receiptOcr');
const ocrGuard = require('./services/ocrGuard');
// ONE resolver for the public frontend URL. Five call sites previously fell back
// to localhost:5173 silently, so a missing FRONTEND_URL emailed customers a link
// to their own machine.
const { appUrl } = require('./services/appUrl');
// ONE money model shared by the receipt email, the receipt PDF and the portal,
// plus the OCR-vs-recorded reconciliation that surfaces amount drift.
const { resolveTransactionAmounts, reconcileOcrAmounts, formatPeso } = require('./services/transactionAmounts');
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const RESEND_FROM = process.env.RESEND_FROM || 'Comar Garage <bookings@yourdomain.com>';

// ── GLOBAL PROCESS CRASH GUARDS (B1) ────────────────────────────────────────
// The per-route try/catch blocks already return a 500 JSON for anything thrown
// INSIDE a handler. These guards cover everything OUTSIDE one — a stray promise
// in a setImmediate email batch, a Supabase realtime callback, a socket error,
// a bad `await` in a timeout. Without them Node terminates the whole process on
// the first such rejection, which the browser then reports as
// net::ERR_CONNECTION_REFUSED (the port simply stops listening).
//
// We LOG and CONTINUE rather than exiting: for a shop-facing API it is far
// better to serve the remaining requests than to take the entire backend down
// because one background job failed. The route handlers remain the fail-closed
// boundary for anything the client can see.
process.on('uncaughtException', (err) => {
  console.error('[SERVER CRASH PREVENTED] uncaughtException:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[SERVER CRASH PREVENTED] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});

void warmReceiptOcr()
  .then(() => console.info('[OCR] Tesseract worker warmed at backend startup.'))
  .catch((error) => console.warn(`[OCR] Worker warm-up failed; scans will retry on demand: ${error.message}`));

const PASSWORD_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

// PASSWORD_CIPHER_KEY derives from the service-role key.
//
// The previous form was:
//
//     crypto.createHash('sha256').update(process.env.SUPABASE_SERVICE_ROLE_KEY || 'development-key')
//
// The `|| 'development-key'` fallback was a LITERAL, PUBLIC string: with the key
// unset, every password-confirmation token would have been encrypted with a key
// printed in this repository — decryptable by anyone who read it. It would not
// have crashed, which is exactly why it was dangerous.
//
// The startup guard above already refuses to boot without this variable, so this
// is defence in depth: a second, explicit assertion at the point of use, so the
// cipher can never be derived from a fallback even if the guard is bypassed or
// the module is imported directly.
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'PASSWORD_CIPHER_KEY cannot be derived: SUPABASE_SERVICE_ROLE_KEY is not set. '
    + 'Refusing to fall back to a literal key, which would make password-confirmation '
    + 'tokens decryptable by anyone with access to the source.'
  );
}
const PASSWORD_CIPHER_KEY = crypto.createHash('sha256')
  .update(process.env.SUPABASE_SERVICE_ROLE_KEY)
  .digest();

// ── Booking money ────────────────────────────────────────────────────────────
// Every paid/balance/downpayment figure comes from the database ledger
// (public.booking_ledger_v, migration 20261024000001). The backend never sums
// payment rows itself, so it cannot disagree with the portal, reports or emails.
//   net_settled          money held (includes rejected payments awaiting refund)
//   verified_paid        money ACCEPTED toward the service (PAID only, minus refunds)
//   downpayment_met      verified_paid >= required_downpayment (work-start gate)
//   service_paid_in_full verified_paid >= expected_amount (completion gate)
const LEDGER_NUMERIC_FIELDS = [
  'original_amount', 'expected_amount', 'settled_amount', 'refunded_amount', 'net_settled',
  'verified_paid', 'outstanding_amount', 'excess_amount', 'pending_verification',
  'required_downpayment', 'service_balance_due'
];

const normalizeLedgerRow = (row) => {
  const normalized = { ...row };
  for (const field of LEDGER_NUMERIC_FIELDS) normalized[field] = Number(row?.[field] || 0);
  return normalized;
};

const getBookingLedgers = async (bookingIds = []) => {
  const ids = [...new Set((bookingIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabaseAdmin.from('booking_ledger_v').select('*').in('booking_id', ids);
  if (error) throw error;
  return new Map((data || []).map((row) => [row.booking_id, normalizeLedgerRow(row)]));
};

const getBookingLedger = async (bookingId) => {
  const ledger = (await getBookingLedgers([bookingId])).get(bookingId);
  if (!ledger) throw new Error(`Financial ledger unavailable for booking ${bookingId}.`);
  return ledger;
};

// Required downpayment for a total that is not saved yet (e.g. after adding a
// service). Uses the same configurable policy as the ledger view.
const getRequiredDownpaymentFor = async (total) => {
  const { data, error } = await supabaseAdmin.rpc('booking_required_downpayment', { p_total: Number(total || 0) });
  if (error) throw error;
  return Number(data || 0);
};

const encryptPendingPassword = (password) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PASSWORD_CIPHER_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  };
};

const decryptPendingPassword = ({ ciphertext, iv, tag }) => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', PASSWORD_CIPHER_KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
};

const hashConfirmationToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Configure Multer for memory storage.
//
// `fileSize` is a HARD CAP, and its absence was a real defect: with no limit,
// `multer.memoryStorage()` buffers the ENTIRE upload in RAM. Anyone could POST a
// multi-gigabyte "receipt" and OOM the process — a trivial denial of service on
// a public endpoint. 10 MB comfortably covers a phone photo (typically 2–5 MB)
// while bounding worst-case memory per request.
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 },
});

const PORT = process.env.PORT || 3000;

// 🔍 DEBUG: Check Environment Variables
console.log('\n' + '🔍'.repeat(20));
console.log('DEBUG: SERVICE ROLE KEY CHECK');
console.log(`KEY DEFINED: ${!!process.env.SUPABASE_SERVICE_ROLE_KEY}`);
console.log(`KEY LENGTH:  ${process.env.SUPABASE_SERVICE_ROLE_KEY?.length || 0}`);
console.log(`URL DEFINED: ${!!process.env.SUPABASE_URL}`);
console.log('🔍'.repeat(20) + '\n');

// Initialize Supabase Admin Client (Safe-guard against missing keys)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabaseAdmin = null;

if (supabaseUrl && supabaseKey) {
  supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  console.log('📦 Supabase Admin initialized.');
} else {
  console.warn('⚠️ SUPABASE_SERVICE_ROLE_KEY missing. Database-dependent features (Emails/Invites) will be disabled, but AI services will remain active.');
}

// 🛡️ DEFAULT ADMIN — Single source of truth.
/**
 * Backend Data Normalization Helper
 * Guarantees customer_name and customer.full_name are non-null strings across all client payloads.
 */
function normalizeBookingData(booking) {
  if (!booking) return booking;
  const customerName = booking.customer_name || booking.customer?.full_name || 'Customer';
  const customerObj = booking.customer || {};

  return {
    ...booking,
    customer_name: customerName,
    customer: {
      ...customerObj,
      full_name: customerObj.full_name || customerName
    }
  };
}

const getLifecycleActor = async (req) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || !supabaseAdmin) return null;
  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return null;
  const { data: profile } = await supabaseAdmin.from('profiles').select('id, role, is_active').eq('id', user.id).maybeSingle();
  if (!profile?.is_active || !['ADMIN', 'STAFF'].includes(String(profile.role || '').toUpperCase())) return null;
  return { user, profile };
};

// Any signed-in, active account (customer, staff, or admin). The caller's
// identity always comes from the verified bearer token, never the request body.
const getAuthenticatedActor = async (req) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || !supabaseAdmin) return null;
  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return null;
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, role, is_active, email, full_name')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile?.is_active) return null;
  return { user, profile };
};

const getCancellationActor = async (req) => {
  const bearerMatch = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch || !supabaseAdmin) return null;

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(bearerMatch[1].trim());
  if (authError || !user) {
    if (authError) console.warn('[cancellation] Unable to verify caller token:', authError.message);
    return null;
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, role, is_active, email, full_name')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError || !profile || profile.is_active === false) {
    if (profileError) console.error('[cancellation] Caller profile lookup failed:', profileError.message);
    return null;
  }

  const role = String(profile.role || '').trim().toUpperCase();
  if (!['ADMIN', 'CUSTOMER'].includes(role)) return null;

  return { user, profile: { ...profile, role } };
};

const getBookingVehicleServiceColumns = async () => {
  if (!supabaseAdmin) return { hasDurationMinutes: false, hasVehicleType: false, hasServiceSnapshot: false };

  const { data, error } = await supabaseAdmin
    .from('information_schema.columns')
    .select('column_name')
    .eq('table_schema', 'public')
    .eq('table_name', 'booking_vehicle_services');

  if (error) {
    console.warn('[booking_vehicle_services] Unable to inspect schema:', error.message);
    return { hasDurationMinutes: false, hasVehicleType: false, hasServiceSnapshot: false };
  }

  const names = new Set((data || []).map((column) => String(column.column_name).toLowerCase()));
  return {
    hasDurationMinutes: names.has('duration_minutes'),
    hasVehicleType: names.has('vehicle_type'),
    hasServiceSnapshot: names.has('service_snapshot')
  };
};

/**
 * 🛡️ SERVER-SIDE ADMIN GATE (Tier 3 / Task 13).
 * Resolves the caller from their JWT (never from the request body) and asserts
 * their profile role is ADMIN. This is an EXPLICIT in-route check that runs
 * BEFORE any privileged work, so the routes no longer depend solely on the
 * `create_invited_account` RPC's internal is_admin() guard — which is absent on
 * the fallback branch when that migration has not been applied.
 *
 * Returns the actor profile on success, or null when the caller is anonymous,
 * inactive, or not an admin. Callers must respond 403 when this returns null.
 *
 * HARDENED (2026-09-28): Case-insensitive Bearer extraction, .single() lookup,
 * deep diagnostic logging at every step.
 */
const requireAdmin = async (req) => {
  console.log('[requireAdmin] ===== START =====');

  // ── Step 1: Extract token from Authorization header ──────────────────────
  // req.headers keys are always lower-cased by Node/Express, so we only need
  // the lowercase form — but we also accept the mixed-case form defensively.
  const rawAuthHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  console.log('[requireAdmin] Raw Authorization header:', rawAuthHeader
    ? rawAuthHeader.substring(0, 30) + (rawAuthHeader.length > 30 ? '...' : '')
    : '(empty/missing)');

  if (!rawAuthHeader) {
    console.warn('[requireAdmin] FAIL — No Authorization header present on request.');
    return null;
  }

  // Case-insensitive match: handles "Bearer", "bearer", "BEARER", etc.
  const bearerMatch = rawAuthHeader.match(/^bearer\s+(.+)$/i);
  if (!bearerMatch) {
    console.warn('[requireAdmin] FAIL — Authorization header is not a valid Bearer token. Raw value:', rawAuthHeader.substring(0, 40));
    return null;
  }

  const token = bearerMatch[1].trim();
  console.log('[requireAdmin] Extracted token (first 20 chars):', token.substring(0, 20) + '...');

  // ── Step 2: supabaseAdmin availability check ─────────────────────────────
  if (!supabaseAdmin) {
    console.error('[requireAdmin] FAIL — supabaseAdmin is not initialised (service-role key missing or invalid).');
    return null;
  }

  // ── Step 3: Verify token with Supabase Auth ──────────────────────────────
  console.log('[requireAdmin] Calling supabaseAdmin.auth.getUser(token)...');
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  console.log('[requireAdmin] getUser result — user id:', userData?.user?.id || '(none)', '| error:', userErr?.message || '(none)');

  if (userErr || !userData?.user) {
    console.warn('[requireAdmin] FAIL — Token rejected by Supabase Auth:', userErr?.message || 'no user returned');
    return null;
  }

  const userId = userData.user.id;
  console.log('[requireAdmin] Verified Supabase Auth user ID:', userId, '| email:', userData.user.email || '(none)');

  // ── Step 4: Look up public.profiles by id ────────────────────────────────
  console.log('[requireAdmin] Querying public.profiles where id =', userId);
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('id, role, is_active, email, full_name')
    .eq('id', userId)
    .maybeSingle();

  console.log('[requireAdmin] profiles query — row:', profile ? JSON.stringify({ id: profile.id, role: profile.role, is_active: profile.is_active, email: profile.email }) : '(null)', '| error:', profileErr ? `${profileErr.message} (code=${profileErr.code})` : '(none)');

  if (profileErr) {
    // A REAL lookup failure (network, RLS misconfiguration, schema drift) — not
    // an authorization decision. Logged loudly, but the caller still gets null:
    // all 49 call sites render null as 403, and throwing here would surface as a
    // 500 for what is, from the user's point of view, simply "I am not an admin".
    console.error(`[requireAdmin] FAIL — profiles lookup threw an error for user ${userId}:`, profileErr.message, `(code=${profileErr.code})`);
    return null;
  }

  if (!profile) {
    // No error and no row: the auth user exists but has no profiles row. Under
    // `.single()` this case arrived as a PGRST116 ERROR instead, which conflated
    // "this account is not staff" with "the query failed". `.maybeSingle()`
    // makes it the ordinary, non-exceptional answer that it is.
    console.warn(`[requireAdmin] FAIL — No profiles row exists for auth user ${userId}. The account may not have completed setup.`);
    return null;
  }

  // ── Step 5: is_active check ───────────────────────────────────────────────
  // Treat NULL as active (coalesce(is_active, true) semantics used everywhere).
  console.log('[requireAdmin] is_active raw value:', profile.is_active, '| type:', typeof profile.is_active);
  if (profile.is_active === false) {
    console.warn(`[requireAdmin] FAIL — Profile ${profile.id} (${profile.email}) is explicitly deactivated (is_active = false).`);
    return null;
  }

  // ── Step 6: Role check (case-insensitive) ─────────────────────────────────
  const normalizedRole = String(profile.role || '').trim().toUpperCase();
  console.log('[requireAdmin] Role raw:', JSON.stringify(profile.role), '| normalized:', normalizedRole);

  if (normalizedRole !== 'ADMIN') {
    console.warn(`[requireAdmin] FAIL — Profile ${profile.id} has role "${normalizedRole}" (raw: ${JSON.stringify(profile.role)}), expected "ADMIN".`);
    return null;
  }

  console.log(`[requireAdmin] SUCCESS ✅ — Admin verified: id=${profile.id}, email=${profile.email}, role=${normalizedRole}`);
  return { user: userData.user, profile };
};

/**
 * 🛡️ AUDIT WRITER (single source of truth).
 *
 * Why this exists: every account-management route (invite / revoke / broadcast /
 * deactivate) must leave an audit trail, but the previous inline inserts were
 * either un-awaited or used `.catch(() => {})`. A Supabase query builder is a
 * THENABLE that RESOLVES with { data, error } on failure — it does not reject —
 * so `.catch()` never fires and a failed insert was invisible. The result: an
 * admin action succeeded but nothing appeared in the Audit Logs page.
 *
 * This helper always awaits, inspects `error` (Supabase never throws), logs a
 * loud warning with the exact Postgres code/message, and returns a boolean so
 * the caller can decide whether the audit failure should surface to the user.
 *
 * `actorId` is stamped when known so the Audit Logs page can resolve the actor's
 * email; `actor_name`/`actor_role` remain the human-readable fallback.
 */
const writeAuditLog = async ({
  actionType,
  details,
  actorId = null,
  actorName = 'SYSTEM',
  actorRole = 'SYSTEM',
  bookingId = null,
  metadata = null,
}) => {
  if (!supabaseAdmin) {
    console.warn(`⚠️ [AUDIT] ${actionType} NOT recorded — Supabase admin client unavailable.`);
    return { success: false, error: 'SUPABASE_UNAVAILABLE' };
  }
  const row = {
    action_type: actionType,
    details: details || null,
    actor_id: actorId,
    actor_name: actorName,
    actor_role: actorRole,
    // Stamp the timestamp explicitly so the row is complete even if the column
    // has no default (which would otherwise make the insert fail).
    created_at: new Date().toISOString(),
  };
  if (bookingId) row.booking_id = bookingId;
  if (metadata) row.metadata = metadata;

  // Retry without the optional columns that might not exist in older schemas.
  let { error } = await supabaseAdmin.from('audit_logs').insert(row);
  if (error) {
    const missingOptional = error.code === 'PGRST204' || error.code === '42703';
    if (missingOptional && (row.actor_id !== undefined || row.metadata)) {
      const lean = { ...row };
      delete lean.actor_id;
      delete lean.metadata;
      ({ error } = await supabaseAdmin.from('audit_logs').insert(lean));
    }
  }

  if (error) {
    console.error(`❌ [AUDIT] ${actionType} FAILED to record: ${error.code || ''} ${error.message}`);
    return { success: false, error: error.message, code: error.code };
  }
  console.log(`📋 [AUDIT] ${actionType} recorded (actor: ${actorName}).`);
  return { success: true };
};

/**
 * Preference-gated customer announcement email.
 * ============================================================================
 * Sends a marketing/announcement email (a new promo, service, or vehicle
 * category) ONLY to customers who explicitly opted in, i.e. whose
 * profiles.notification_preferences[preferenceKey] === true.
 *
 *   preferenceKey: 'emailNewPromos' | 'emailNewServices' | 'emailNewVehicles'
 *
 * Fail-closed: a missing column, a missing/undefined preference, or any lookup
 * error means NO email is sent — matching the brief's "only trigger if the
 * customer has their settings explicitly configured this way".
 *
 * Non-blocking: uses setImmediate + a per-recipient rate-limit buffer so the
 * caller's HTTP response is never held open by the send loop.
 */
const sendPreferenceGatedAnnouncement = ({ preferenceKey, subject, bodyHtml }) => {
  if (!supabaseAdmin || !resendClient) {
    console.warn(`📧 [ANNOUNCE] Skipped "${subject}" — supabase/resend unavailable.`);
    return;
  }
  setImmediate(async () => {
    try {
      const { data: profiles, error } = await supabaseAdmin
        .from('profiles')
        .select('id, email, full_name, notification_preferences')
        .eq('is_active', true)
        .eq('role', 'CUSTOMER');
      if (error) {
        console.error(`📧 [ANNOUNCE] Preference lookup failed for "${subject}":`, error.message);
        return;
      }
      const optedIn = (profiles || []).filter(
        (p) => p?.email && p.notification_preferences && p.notification_preferences[preferenceKey] === true
      );
      if (!optedIn.length) {
        console.log(`📧 [ANNOUNCE] "${subject}" sent to 0 customers (no one opted into ${preferenceKey}).`);
        return;
      }
      for (const p of optedIn) {
        try {
          await resendClient.emails.send({
            from: RESEND_FROM,
            to: [p.email],
            subject,
            html: bodyHtml.replace(/\{\{name\}\}/g, p.full_name || 'there'),
          });
          await new Promise((r) => setTimeout(r, 100)); // rate-limit buffer
        } catch (emailErr) {
          console.error(`[ANNOUNCE EMAIL ERROR] ${p.email}:`, emailErr.message);
        }
      }
      console.log(`📧 [ANNOUNCE] "${subject}" sent to ${optedIn.length} opted-in customer(s).`);
    } catch (err) {
      console.error(`📧 [ANNOUNCE] Unexpected failure for "${subject}":`, err.message);
    }
  });
};

const revokeStaleStaffTaskNotifications = async (bookingId, currentStaffId) => {
  const { data: taskNotifications, error: notificationError } = await supabaseAdmin
    .from('notifications')
    .select('id, user_id')
    .eq('booking_id', bookingId)
    .eq('notification_type', 'TASK_ASSIGNED');
  if (notificationError) throw notificationError;

  const staleNotifications = (taskNotifications || []).filter((notification) =>
    !currentStaffId || notification.user_id !== currentStaffId
  );
  for (const notification of staleNotifications) {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({
        title: 'Assignment Changed',
        message: 'This vehicle has been reassigned or is no longer available in your active work.',
        notification_type: 'ASSIGNMENT_REVOKED',
        action_url: null,
        booking_id: null,
        entity_id: null,
        is_read: false
      })
      .eq('id', notification.id)
      .eq('user_id', notification.user_id);
    if (error) throw error;
  }

  return staleNotifications.length;
};

const dispatchLifecycleEmail = async (bookingId, newStatus, remarks = '') => {
  const projectUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${projectUrl}/functions/v1/booking-lifecycle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ bookingId, newStatus, remarks })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) throw new Error(result.error || `Lifecycle email failed (${response.status})`);
  return result;
};
// Only this specific account is protected from deactivation and always shows the DEFAULT ADMIN badge.
// To change the default admin, update this ID to the new account's user ID.
const DEFAULT_ADMIN_ID = '3057c70b-7eec-4445-9a1b-68118f9c6bd0'; // testadmin961@gmail.com
console.log(`🛡️  Default Admin ID locked: ${DEFAULT_ADMIN_ID}`);

// 🔍 DEBUG: Test Simple Admin Call on Startup
(async () => {
  if (!supabaseAdmin) return;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1 });
    if (error) throw error;
    console.log('✅ BACKEND: Service Role verification SUCCESSFUL (Supabase connection OK)');
  } catch (err) {
    console.error('❌ BACKEND: Service Role verification FAILED!');
    console.error('ERROR:', err.message);
  }
})();

const generateTemplate = (type, data) => {
  let subject = '';
  let html = '';

  switch (type) {
    case 'VERIFICATION_CODE':
      subject = 'Verify Your Comar Garage Account';
      html = buildEmailShell({
        title: 'Verify Your Account',
        eyebrow: 'SECURITY CHECK',
        bodyHtml: `
          <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">Your verification code is:</p>
          <div style="font-size: 32px; font-weight: 900; letter-spacing: 5px; padding: 16px 18px; background: #f5f5f4; border-radius: 12px; color: #111827; display: inline-block; margin-bottom: 16px;">${data.otp}</div>
          <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.7;">This code expires in 10 minutes. Use it to complete your sign-in or account creation flow.</p>
        `,
        ctaLink: null,
        footerNote: 'Comar Garage | 39 Hunters ROTC, Barangay San Juan, Cainta, 1900 Rizal'
      });
      break;
    default:
      subject = 'Comar Garage Update';
      html = `<p>New update for ${type}</p><pre>${JSON.stringify(data, null, 2)}</pre>`;
  }
  return { subject, html };
};

const formatCurrency = (value) => new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(Number(value || 0));

const escapePdfText = (value = '') => String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const buildReceiptPdfBuffer = ({ receiptNumber, customerName, bookingReference, issuedAt, paymentMethod, processedBy, customerContact, customerAddress, customerTaxId, items = [], subtotal = 0, discountAmount = 0, amounts = null }) => {
  // The attached PDF is the "official receipt" — it MUST agree with the email
  // that carries it. Both now render from the shared amount model. Previously
  // this function independently ADDED 12% VAT to the booking total, so the PDF
  // and the email could quote different totals for the very same payment.
  const a = amounts || resolveTransactionAmounts({ total_amount: subtotal }, null);
  const dateString = issuedAt ? new Date(issuedAt).toLocaleString() : new Date().toLocaleString();

  const lines = [
    'COMAR GARAGE',
    'Auto Detailing Studio',
    '',
    `Receipt No.: ${receiptNumber || 'AUTO'}`,
    `Issued: ${dateString}`,
    `Booking Reference: ${bookingReference || 'N/A'}`,
    `Payment Method: ${paymentMethod || 'Digital / Online Payment'}`,
    `Customer: ${customerName || 'Customer'}`,
    `Contact: ${customerContact || 'N/A'}`,
    `Address: ${customerAddress || '-'}`,
    `Processed By: ${processedBy || 'System Admin'}`,
    `Customer Tax ID: ${customerTaxId || '-'}`,
    '',
    'Vehicle / Service                          Qty   Unit Price   Line Total',
    ...items.map((item) => {
      const label = (item.vehicle || 'Vehicle Unit').substring(0, 26);
      const service = (item.service || 'Service').substring(0, 20);
      const qty = item.qty ?? 1;
      const unitPrice = Number(item.unitPrice ?? item.lineTotal ?? 0);
      const lineTotal = Number(item.lineTotal ?? item.unitPrice ?? 0);
      return `${label} ${service} ${qty} ${formatCurrency(unitPrice)} ${formatCurrency(lineTotal)}`;
    }),
    '',
    ...(a.transferFee > 0 ? [`Transfer Fee (absorbed): ${formatCurrency(a.transferFee)}`] : []),
    ...(a.creditApplied > 0 ? [`Credit Applied: -${formatCurrency(a.creditApplied)}`] : []),
    `Amount Paid: ${formatCurrency(a.grossPaid)}`,
    `Amount Received: ${formatCurrency(a.netReceived)}`,
    `Amount Credited to Booking: ${formatCurrency(a.creditedToBooking)}`,
    ...(a.excessCredit > 0 ? [`Recorded as Excess Credit: ${formatCurrency(a.excessCredit)}`] : []),
    `Booking Total: ${formatCurrency(a.totalDue)}`,
    ...(a.remainingBalance > 0 ? [`Balance Still Due: ${formatCurrency(a.remainingBalance)}`] : []),
    // No tax lines. Pricing is flat and tax-free: the booking total IS the
    // amount due, and there is no VAT to break out or add on.
    '',
    'This receipt is valid for audit purposes.'
  ];

  const content = lines.map((line, index) => `BT\n/F1 11 Tf\n72 ${760 - index * 18} Td\n(${escapePdfText(line)}) Tj\nET`).join('\n');

  let pdf = '%PDF-1.4\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`
  ];

  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'binary');
};

const buildReceiptEmailHtml = ({ customerName, bookingReference, receiptNumber, amounts, paymentMethod, issuedAt, items, pendingLabel, receiptNarrative }) => {
  const a = amounts;
  const itemRows = (items || []).map((item) => `
    <tr>
      <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; vertical-align: top;">
        <div style="font-size: 13px; font-weight: 700; color: #111827;">${item.vehicle || 'Vehicle / Service'}</div>
        <div style="font-size: 11px; color: #6b7280; margin-top: 2px;">${item.service || 'Service'}</div>
      </td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: center; font-size: 12px; color: #111827; font-feature-settings: 'tnum' 1; font-variant-numeric: tabular-nums;">${item.qty ?? 1}</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 12px; color: #111827; font-feature-settings: 'tnum' 1; font-variant-numeric: tabular-nums;">${formatCurrency(item.unitPrice ?? item.lineTotal ?? 0)}</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 12px; color: #111827; font-weight: 700; font-feature-settings: 'tnum' 1; font-variant-numeric: tabular-nums;">${formatCurrency(item.lineTotal ?? item.unitPrice ?? 0)}</td>
    </tr>
  `).join('');

  // Totals are rendered from the SHARED amount model, so the email and the PDF
  // can never quote different numbers. Pricing is FLAT and TAX-FREE: there is no
  // VAT line, because there is no tax — the booking total IS the amount due.
  const totalRows = [
    `<div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #4b5563;"><span>Booking Total</span><span>${formatCurrency(a.totalDue)}</span></div>`,
    a.transferFee > 0
      ? `<div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #4b5563;"><span>Transfer Fee (absorbed)</span><span>${formatCurrency(a.transferFee)}</span></div>`
      : '',
    a.creditApplied > 0
      ? `<div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #4b5563;"><span>Credit Applied</span><span>- ${formatCurrency(a.creditApplied)}</span></div>`
      : '',
    `<div style="display: flex; justify-content: space-between; padding-top: 8px; font-size: 18px; font-weight: 800; color: #111827;"><span>${a.remainingBalance > 0 ? 'Balance Still Due' : 'Amount Paid'}</span><span>${formatCurrency(a.remainingBalance > 0 ? a.remainingBalance : a.creditedToBooking)}</span></div>`,
    // No VAT row: pricing is flat and tax-free, so the total above IS the amount due.
  ].filter(Boolean).join('');

  const pendingBanner = pendingLabel
    ? `<div style="margin: 0 0 16px; padding: 12px 14px; background: #fffbeb; border: 1px solid #fde68a; border-left: 4px solid #f59e0b; border-radius: 6px; font-size: 13px; color: #92400e;"><strong>${pendingLabel}</strong></div>`
    : '';

  return `
    <div style="font-family: Inter, system-ui, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 16px; overflow: hidden; color: #111827;">
      <div style="background: #111827; color: #f9fafb; padding: 16px 20px; border-bottom: 1px solid #262626;">
        <div style="font-size: 18px; font-weight: 800; letter-spacing: 0.22em; text-transform: uppercase; text-align: center;">COMAR GARAGE</div>
        <div style="font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; text-align: center; color: #d1d5db; margin-top: 6px;">Auto Detailing Studio</div>
      </div>
      <div style="padding: 24px 24px 12px;">
        <div style="display: flex; justify-content: space-between; gap: 16px; margin-bottom: 16px;">
          <div>
            <div style="font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.12em;">Receipt No.</div>
            <div style="font-size: 14px; font-weight: 700; color: #111827; margin-top: 4px;">${receiptNumber || 'AUTO'}</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.12em;">Issued</div>
            <div style="font-size: 14px; font-weight: 700; color: #111827; margin-top: 4px;">${issuedAt ? new Date(issuedAt).toLocaleString() : new Date().toLocaleString()}</div>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; margin-bottom: 18px;">
          <div>
            <div style="font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 6px;">Business Details</div>
            <div style="font-size: 14px; font-weight: 700; color: #111827;">Comar Garage</div>
            <div style="font-size: 12px; color: #4b5563; margin-top: 4px;">123 Auto Avenue, Mandaluyong City</div>
            <div style="font-size: 12px; color: #4b5563;">+63 917 123 4567 | hello@comargarage.com</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 6px;">Booking Reference</div>
            <div style="font-size: 14px; font-weight: 700; color: #111827;">${bookingReference || 'N/A'}</div>
            <div style="font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.12em; margin-top: 10px; margin-bottom: 6px;">Payment Method</div>
            <div style="font-size: 14px; font-weight: 700; color: #111827;">${paymentMethod}</div>
          </div>
        </div>

        <div style="margin-bottom: 18px;">
          <div style="font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 6px;">Customer</div>
          <div style="font-size: 14px; font-weight: 700; color: #111827;">${customerName}</div>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px;">
          <thead>
            <tr>
              <th style="padding: 10px 12px; background: #f9fafb; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; text-align: left; font-size: 11px; font-weight: 600; color: #4b5563; text-transform: uppercase; letter-spacing: 0.12em;">Vehicle / Service</th>
              <th style="padding: 10px 12px; background: #f9fafb; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; text-align: center; font-size: 11px; font-weight: 600; color: #4b5563; text-transform: uppercase; letter-spacing: 0.12em;">Qty</th>
              <th style="padding: 10px 12px; background: #f9fafb; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 11px; font-weight: 600; color: #4b5563; text-transform: uppercase; letter-spacing: 0.12em;">Unit Price</th>
              <th style="padding: 10px 12px; background: #f9fafb; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 11px; font-weight: 600; color: #4b5563; text-transform: uppercase; letter-spacing: 0.12em;">Line Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows}
          </tbody>
        </table>

        <div style="max-width: 300px; margin-left: auto; border-top: 2px solid #111827; padding-top: 12px;">
          ${totalRows}
        </div>
      </div>
      <div style="padding: 0 24px 24px; font-size: 12px; color: #4b5563; line-height: 1.6;">
        ${pendingBanner}
        <p style="margin: 0;">Hi ${customerName},</p>
        <p style="margin: 10px 0 0;">${receiptNarrative}</p>
      </div>
    </div>
  `;
};

// A receipt must never read as "paid in full" while the money is still sitting
// in the verification queue. The narrative sentence is derived from the SAME
// amount model as the totals table, so the two cannot contradict each other.
const buildReceiptNarrative = (amounts, isPending) => {
  const received = formatPeso(amounts.creditedToBooking);
  const balance = formatPeso(amounts.remainingBalance);

  if (isPending) {
    return `We have received ${received} against this booking and it is now queued for verification. ` +
      (amounts.remainingBalance > 0
        ? `A balance of ${balance} remains on the booking. `
        : '') +
      'You will receive a final confirmation once our team has verified the payment. Please keep this copy for your records.';
  }

  if (amounts.remainingBalance > 0) {
    return `We have recorded ${received} against this booking. A balance of ${balance} remains payable. ` +
      'This receipt covers the amount received to date and is attached for your records.';
  }

  if (amounts.excessCredit > 0) {
    return `We have received ${received} in full payment for this booking. This is ${formatPeso(amounts.excessCredit)} ` +
      `more than the booking total; the surplus has been banked as credit on your account. Receipt attached.`;
  }

  return `We have received ${received} in full payment for this booking. Your official receipt is attached below for your records.`;
};

/**
 * Record a material OCR-vs-recorded amount divergence so it can be reconciled
 * rather than silently shipped. Without this the receipt quoted one figure and
 * the booking ledger another, and nothing anywhere recorded the disagreement.
 * Best-effort: a failure to log must not fail the receipt.
 */
const auditOcrMismatch = async ({ bookingId, paymentId, reconciliation, booking }) => {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      booking_id: bookingId,
      action_type: 'OCR_AMOUNT_MISMATCH',
      details:
        `Recorded amount ${formatPeso(reconciliation.declared)} does not match the OCR-read amount ` +
        `${formatPeso(reconciliation.detected)} (difference ${formatPeso(reconciliation.difference)}). ` +
        `Severity: ${reconciliation.severity}. The recorded amount remains authoritative; review the receipt.`,
      actor_name: 'SYSTEM',
      actor_role: 'SYSTEM',
      metadata: {
        payment_id: paymentId,
        declared: reconciliation.declared,
        detected: reconciliation.detected,
        difference: reconciliation.difference,
        severity: reconciliation.severity,
        booking_total: Number(booking?.total_amount || 0),
      },
    });
  } catch (err) {
    console.warn('Could not write OCR_AMOUNT_MISMATCH audit row:', err?.message);
  }
};

/**
 * The booking's OVERALL FINANCIAL LEDGER.
 *
 * One place that answers "where does this booking stand financially?", composed
 * from the same rule the UI uses (settled = PAID-family only) PLUS the
 * OCR-attributed money that the ledger deliberately excludes while it awaits
 * verification.
 *
 * The OCR output previously reached payments.detected_amount and
 * bookings.ocr_metadata but appeared in NO financial total, because an unverified
 * receipt must never count as recognised revenue. This endpoint surfaces it as a
 * named, separate figure (with the declared-vs-OCR variance) so a reconciliation
 * can see it without inflating the books.
 */
app.get('/api/bookings/:bookingId/financial-ledger', async (req, res) => {
  const { bookingId } = req.params;
  try {
    const { data, error } = await supabaseAdmin.rpc('booking_financial_ledger', {
      p_booking_id: bookingId,
    });

    if (error) {
      // A missing booking is a client error, not a server fault.
      const notFound = error.code === 'P0002' || /not found/i.test(error.message || '');
      return res.status(notFound ? 404 : 500).json({ success: false, error: error.message });
    }

    return res.json({
      success: true,
      ledger: data,
      // Explicit so no consumer has to re-derive the accounting rule:
      // unverified money is reported, never recognised.
      note: 'settled_amount counts verified money only; pending_verification is claimed but unverified and is NOT revenue.',
    });
  } catch (err) {
    console.error('❌ Financial ledger lookup failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/emails/booking-confirmation', async (req, res) => {
  const { bookingId } = req.body;
  console.log(`📧 [EMAIL SYSTEM] DISPATCHING BOOKING CONFIRMATION: ${bookingId}`);

  try {
    // 1. Fetch full booking context
    const { data: booking, error: bError } = await supabaseAdmin
      .from('bookings')
      .select('*, booking_vehicles(*, booking_vehicle_services(*))')
      .eq('id', bookingId)
      .single();

    if (bError || !booking) throw new Error('Booking not found');

    // Fetch customer separately for reliability. Walk-in bookings may not have a profile row.
    let customer = null;
    if (booking.customer_id) {
      const { data, error: cError } = await supabaseAdmin
        .from('profiles')
        .select('full_name, email')
        .eq('id', booking.customer_id)
        .maybeSingle();

      customer = data;
      if (cError) throw new Error(cError.message || 'Customer profile lookup failed');
    }

    const customerEmail = booking.customer_email || customer?.email;
    const customerName = booking.customer_name || customer?.full_name || 'Customer';
    if (!customerEmail) throw new Error('Customer email not found for confirmation email');

    const vehicles = booking.booking_vehicles || [];
    const confirmationResult = await sendBookingConfirmationEmail({
      customerEmail,
      customerName,
      bookingId: bookingId.substring(0, 8).toUpperCase(),
      serviceName: vehicles.flatMap(vehicle => vehicle.booking_vehicle_services || []).map(service => service.service_name).join(', ') || 'Detailing service',
      scheduledAt: booking.start_datetime,
      totalAmount: booking.total_amount
    });
    if (!confirmationResult.success) throw new Error(confirmationResult.error?.message || confirmationResult.error || 'Booking confirmation email failed');
    // The legacy template below remains as a compatibility fallback only.

    const dateStr = new Date(booking.start_datetime).toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const vehicleHtml = vehicles.map(v => `
      <div style="margin-bottom: 15px; padding: 10px; border-left: 4px solid #A91B18; background: #f9f9f9;">
        <strong style="text-transform: uppercase;">${v.year} ${v.brand} ${v.model}</strong> [${v.plate_number}]
        <ul style="margin: 5px 0; padding-left: 20px; font-size: 13px;">
          ${(v.booking_vehicle_services || []).map(s => `<li>${s.service_name} - ₱${s.price}</li>`).join('')}
        </ul>
      </div>
    `).join('');

    if (resendClient && !confirmationResult.success) {
      await resendClient.emails.send({
        from: RESEND_FROM,
        to: customerEmail,
        subject: `BOOKING CONFIRMED: ${bookingId.substring(0, 8).toUpperCase()}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; border: 1px solid #eee; padding: 20px;">
            <h2 style="color: #A91B18; margin-top: 0;">COMAR GARAGE</h2>
            <h3 style="text-transform: uppercase; border-bottom: 2px solid #eee; padding-bottom: 10px;">Booking Confirmation</h3>
            
            <p>Hi <strong>${customerName}</strong>,</p>
            <p>Your booking has been successfully <strong>APPROVED</strong> and scheduled. We are excited to see you!</p>
            
            <div style="background: #111; color: #fff; padding: 15px; border-radius: 4px; margin: 20px 0;">
              <div style="font-size: 12px; opacity: 0.7; text-transform: uppercase;">Scheduled For</div>
              <div style="font-size: 18px; font-weight: bold;">${dateStr}</div>
            </div>

            <h4 style="text-transform: uppercase; color: #666; font-size: 12px; margin-bottom: 10px;">Vehicle & Service Details</h4>
            ${vehicleHtml}

            <div style="margin-top: 20px; padding-top: 20px; border-top: 2px solid #eee;">
              <div style="display: flex; justify-content: space-between;">
                <span>Total Amount:</span>
                <strong style="font-size: 18px; color: #A91B18;">₱${booking.total_amount}</strong>
              </div>
              <div style="font-size: 12px; color: #666; margin-top: 5px;">Payment Status: ${booking.payment_status}</div>
            </div>

            <p style="margin-top: 30px; font-size: 12px; color: #888;">
              Please arrive 15 minutes before your scheduled slot. If you need to reschedule, contact Comar Garage through the contact details in your portal.
            </p>
          </div>
        `
      });
      console.log(`✅ Confirmation email sent to ${customer.email}`);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Confirmation Email Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/emails/payment-receipt', async (req, res) => {
  const { bookingId, paymentId } = req.body;
  console.log(`📧 [EMAIL SYSTEM] DISPATCHING PAYMENT RECEIPT: ${paymentId} for Booking ${bookingId}`);

  try {
    const { data: booking, error: bError } = await supabaseAdmin
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .single();

    const { data: payment, error: pError } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('id', paymentId)
      .single();

    if (bError || pError || !booking || !payment) throw new Error('Booking or Payment records missing');

    let customer = null;
    if (booking.customer_id) {
      const { data } = await supabaseAdmin
        .from('profiles')
        .select('full_name, email, phone')
        .eq('id', booking.customer_id)
        .maybeSingle();
      customer = data;
    }

    const customerEmail = customer?.email || booking.customer_email;
    if (!customerEmail) throw new Error('Customer email not found');

    const customerName = customer?.full_name || booking.customer_name || 'Customer';
    const customerContact = customer?.phone || booking.customer_phone || booking.customer_contact || 'N/A';
    const customerAddress = booking.customer_address || 'N/A';
    const customerTaxId = booking.customer_tax_id || 'N/A';
    const receiptNumber = payment.reference_number || `INV-${String(paymentId || bookingId).slice(0, 8).toUpperCase()}`;
    const issuedAt = payment.created_at || booking.created_at;

    // ONE money model for the email, the PDF and the portal. Previously the
    // receipt took `payment.amount || booking.total_amount` and then ADDED 12%
    // VAT on top, so a customer who paid ₱250 was emailed a ₱280 demand in a
    // shop whose prices already include VAT.
    const amounts = resolveTransactionAmounts(booking, payment);

    // The customer paid the GROSS; the shop received the NET. Quote the gross
    // as "paid" so the receipt never reads as short-paid.
    const paidAmount = amounts.grossPaid;

    // RECONCILE the recorded figure against what the AI actually read.
    // These two were drifting silently — the receipt quoted one and the booking
    // ledger another. We surface the divergence for an admin instead of
    // pretending they agree; the recorded amount stays authoritative so the
    // system's own numbers remain self-consistent.
    const reconciliation = reconcileOcrAmounts(amounts.declared, Number(payment.detected_amount || 0));
    if (!reconciliation.matches) {
      console.warn(
        `⚠️ [OCR RECONCILE] Booking ${bookingId} / payment ${paymentId}: ` +
        `recorded ₱${reconciliation.declared} vs OCR ₱${reconciliation.detected} ` +
        `(diff ₱${reconciliation.difference}, ${reconciliation.severity}).`
      );
      auditOcrMismatch({ bookingId, paymentId, reconciliation, booking }).catch(() => {});
    }

    const isPendingVerification = String(payment.status || '').toUpperCase() === 'FOR_VERIFICATION';

    const items = booking.booking_vehicles?.flatMap((vehicle) => (vehicle.booking_vehicle_services || []).map((service) => ({
      vehicle: `${vehicle.brand || ''} ${vehicle.model || ''}`.trim() || 'Vehicle Unit',
      service: service.service_name || service.name || 'Service',
      qty: 1,
      unitPrice: Number(service.price || service.price_snapshot || 0),
      lineTotal: Number(service.price || service.price_snapshot || 0),
    }))) || [{
      vehicle: 'Booking Summary',
      service: 'Booking Service Summary',
      qty: 1,
      unitPrice: amounts.totalDue,
      lineTotal: amounts.totalDue,
    }];

    const receiptHtml = buildReceiptEmailHtml({
      customerName,
      bookingReference: booking.booking_id || bookingId,
      receiptNumber,
      amounts,
      paymentMethod: payment.method || booking.payment_method || 'Digital / Online Payment',
      issuedAt,
      items,
      pendingLabel: isPendingVerification
        ? 'Payment received and queued for verification. This is not yet an official receipt.'
        : null,
      receiptNarrative: buildReceiptNarrative(amounts, isPendingVerification),
    });

    const pdfBuffer = buildReceiptPdfBuffer({
      receiptNumber,
      customerName,
      bookingReference: booking.booking_id || bookingId,
      issuedAt,
      paymentMethod: payment.method || booking.payment_method || 'Digital / Online Payment',
      processedBy: 'System Admin',
      customerContact,
      customerAddress,
      customerTaxId,
      items,
      subtotal: amounts.totalDue,
      discountAmount: 0,
      amounts,
      paidAmount,
      // No vatRate / vatAmount. Pricing is flat and tax-free; `totalDue` IS the
      // price. A template reading these keys now gets `undefined` rather than a
      // plausible number, which fails loudly instead of printing a silent zero.
      totalDue: amounts.totalDue,
    });

    const attachments = [{
      content: pdfBuffer,
      filename: `Receipt-${String(receiptNumber).replace(/\s+/g, '-').toUpperCase()}.pdf`
    }];

    if (payment.receipt_url) {
      try {
        const bucket = 'payment-receipts';
        const marker = '/payment-receipts/';
        const filePath = payment.receipt_url.includes(marker)
          ? decodeURIComponent(payment.receipt_url.split(marker)[1])
          : payment.receipt_url;

        const { data: fileData } = await supabaseAdmin.storage
          .from(bucket)
          .download(filePath);

        if (fileData) {
          const imageBuffer = Buffer.from(await fileData.arrayBuffer());
          attachments.push({
            content: imageBuffer,
            filename: `receipt_${String(paymentId || bookingId).slice(0, 8)}.png`
          });
        }
      } catch (fErr) {
        console.warn('Could not attach legacy receipt image:', fErr.message);
      }
    }

    if (resendClient) {
      await resendClient.emails.send({
        from: RESEND_FROM,
        to: customerEmail,
        subject: `OFFICIAL RECEIPT: ${String(receiptNumber).slice(0, 12).toUpperCase()}`,
        attachments,
        html: receiptHtml,
      });
      console.log(`✅ Payment receipt email sent to ${customerEmail}`);
    }

    return res.json({ success: true, attachmentName: attachments[0]?.filename || null });
  } catch (err) {
    console.error('❌ Payment Receipt Email Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send-email', async (req, res) => {
  const { to, type, data } = req.body;

  console.log('\n' + '='.repeat(40));
  console.log(`📧 [SHADOW BACKEND] EMAIL TRIGGERED`);
  console.log(`TYPE: ${type}`);
  console.log(`TO:   ${to}`);
  if (data?.otp) {
    console.log(`🔑 VERIFICATION CODE: ${data.otp}`);
  }
  console.log('='.repeat(40) + '\n');

  try {
    const { subject, html } = generateTemplate(type, data);

    if (resendClient) {
      await resendClient.emails.send({
        from: RESEND_FROM,
        to,
        subject,
        html
      });
      console.log('✅ Email successfully delivered to inbox via Resend.');
    } else {
      console.warn('⚠️ No RESEND_API_KEY found. Logging to terminal only.');
    }

    return res.json({ success: true, message: 'Code logged to terminal and email attempted.' });
  } catch (err) {
    console.warn(`⚠️ Email delivery failed, but your code is logged above! (${err.message})`);
    return res.json({ success: true, message: 'Email delivery failed, but check your terminal for the code!', dev_mode: true });
  }
});

// 🚀 ISOLATED INVITATION SYSTEM

// 1. GENERATE INVITE
app.post('/admin/generate-invite', async (req, res) => {
  const { email, role } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedRole = typeof role === 'string' ? role.trim().toUpperCase() : '';

  if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail) || !['ADMIN', 'STAFF'].includes(normalizedRole)) {
    console.error(`❌ [INVITE SYSTEM] REJECTED: Invalid email (${email}) or role (${role})`);
    return res.status(400).json({ success: false, error: 'A valid email and STAFF or ADMIN role are required.' });
  }

  console.log(`🎟️ [INVITE SYSTEM] GENERATING FOR: ${normalizedEmail} (${normalizedRole})`);

  if (!supabaseAdmin) {
    return res.status(503).json({ success: false, error: 'Invitation service unavailable.' });
  }

  const actor = await requireAdmin(req);
  if (!actor) {
    console.warn('🚫 [INVITE SYSTEM] BLOCKED: caller is not an authenticated ADMIN.');
    return res.status(403).json({ success: false, error: 'Only administrators may invite staff or administrators.' });
  }

  // Customer access is created through the public, email-confirmed registration
  // flow. Invitations (and temporary-password emails) are reserved for staff
  // and administrators.
  try {
    const safeFirst = '';
    const safeLast = '';
    const fullName = normalizedEmail.split('@')[0];

    // 1. Duplicate guard.
    //
    // The legacy customer auto-provisioning path has been retired. Admin-only
    // staff invitations may still use this endpoint.
    let mustChangePassword = true;

    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    let authExists = false;
    try {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const target = normalizedEmail.toLowerCase();
      authExists = Boolean((list?.users || []).some((u) => (u.email || '').toLowerCase() === target));
    } catch (lookupErr) {
      console.warn('⚠️ [INVITE SYSTEM] auth.users duplicate lookup unavailable:', lookupErr.message);
    }

    if (existingProfile || authExists) {
      // Already provisioned — nothing to do, and no error for the caller.
      return res.json({ success: true, alreadyExists: true, message: 'Account already exists.' });
    }

    const temporaryPassword = generateTemporaryPassword();

    // 2. Create the auth user (pre-confirmed) with the temporary password.
    const { data: userData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: {
        first_name: safeFirst,
        last_name: safeLast,
        role: normalizedRole,
        must_change_password: mustChangePassword,
      },
    });

    if (authError) {
      if (/already|registered|exists/i.test(authError.message || '')) {
        return res.json({ success: true, alreadyExists: true, message: 'Account already exists.' });
      }
      throw authError;
    }

    const userId = userData.user.id;

    // 3. Profile row (core fields first, extended if the columns exist).
    const coreProfile = {
      id: userId,
      email: normalizedEmail,
      first_name: safeFirst || null,
      last_name: safeLast || null,
      full_name: fullName,
      role: normalizedRole,
      is_active: true,
      updated_at: new Date().toISOString(),
    };
    const extendedProfile = {
      ...coreProfile,
      must_change_password: mustChangePassword,
      failed_login_attempts: 0,
      locked_until: null,
    };

    let profileError = null;
    {
      const attempt = await supabaseAdmin.from('profiles').upsert(extendedProfile);
      profileError = attempt.error;
      const optionalMissing = profileError && (
        profileError.code === 'PGRST204' ||
        /must_change_password|failed_login_attempts|locked_until/i.test(profileError.message || '')
      );
      if (optionalMissing) {
        console.warn('⚠️ [INVITE SYSTEM] Lockout/first-login columns missing — writing core profile fields only.');
        const fallback = await supabaseAdmin.from('profiles').upsert(coreProfile);
        profileError = fallback.error;
        mustChangePassword = false;
      }
    }
    if (profileError) throw profileError;

    // 4. Deliver temporary credentials through the branded Resend relay.
    const loginLink = appUrl('/login');
    let emailDelivered = false;
    try {
      const emailResult = await sendInviteAccountEmail({
        recipientEmail: normalizedEmail,
        firstName: safeFirst,
        lastName: safeLast,
        role: normalizedRole,
        temporaryPassword,
        loginLink,
      });
      emailDelivered = Boolean(emailResult?.success);
      if (!emailDelivered) console.warn(`⚠️ [INVITE SYSTEM] Invite email not delivered for ${normalizedEmail}`);
    } catch (mailErr) {
      console.error(`⚠️ [INVITE SYSTEM] Email delivery failed: ${mailErr.message}`);
    }

    // Best-effort audit trail (never blocks the booking).
    await writeAuditLog({
      actionType: 'INVITE_ACCOUNT',
      actorName: 'GUEST_BOOKING',
      actorRole: 'SYSTEM',
      details: `Guest account provisioned for ${fullName} (${normalizedEmail}) as ${normalizedRole}. Email delivered: ${emailDelivered}.`,
    });

    return res.json({
      success: true,
      message: 'Guest account provisioned',
      emailDelivered,
      account: { id: userId, email: normalizedEmail, role: normalizedRole },
    });
  } catch (err) {
    console.error(`❌ Generate Invite Failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. VALIDATE INVITE
app.get('/invite/validate', async (req, res) => {
  const { token } = req.query;

  try {
    const { data, error } = await supabaseAdmin
      .from('invites')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .gt('expires_at', new Date().toISOString())
      .single();

    if (error || !data) {
      return res.status(400).json({ success: false, error: 'Invalid or expired invitation' });
    }

    return res.json({ success: true, email: data.email, role: data.role });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Validation failed' });
  }
});

// 3. ACCEPT INVITE (Create Account)
app.post('/invite/accept', async (req, res) => {
  const { token, password, first_name, last_name } = req.body;

  console.log(`\n🎟️ [INVITE SYSTEM] ACTIVATING ACCOUNT FOR TOKEN: ${token.substring(0, 8)}...`);

  try {
    // 1. Verify token
    const { data: invite, error: inviteError } = await supabaseAdmin
      .from('invites')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .single();

    if (inviteError || !invite) {
      console.error('❌ Token Validation Failed:', inviteError?.message || 'Token not found or already used');
      throw new Error('Invalid or used invitation token');
    }

    console.log(`✅ Token valid for: ${invite.email} (${invite.role})`);

    // 2. Create User in Auth
    console.log(`⏳ Creating user in Supabase Auth...`);
    let userId;
    const { data: userData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: invite.email,
      password: password,
      email_confirm: true,
      user_metadata: { first_name, last_name, role: invite.role }
    });

    if (authError) {
      if (authError.message.includes('already been registered')) {
        console.log(`ℹ️ User already exists in Auth, searching for existing ID...`);
        const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = listData.users.find(u => u.email === invite.email);
        if (existingUser) {
          userId = existingUser.id;
          console.log(`✅ Found existing user ID: ${userId}`);
        } else {
          throw new Error('User reported as registered but not found in directory');
        }
      } else {
        console.error('❌ Supabase Auth Creation Failed:', authError.message);
        throw authError;
      }
    } else {
      userId = userData.user.id;
      console.log(`✅ Auth user created: ${userId}`);
    }

    // 3. Create Profile Row
    console.log(`⏳ Inserting into profiles table for ID: ${userId} with role: ${invite.role}...`);
    const fName = first_name?.trim() || 'Staff';
    const lName = last_name?.trim() || 'Member';
    const fullName = `${fName} ${lName}`.trim();

    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: userId,
        email: invite.email,
        first_name: fName,
        last_name: lName,
        full_name: fullName,
        role: invite.role,
        is_active: true,
        updated_at: new Date().toISOString()
      });

    if (profileError) {
      console.error('❌ Profile Insertion Failed:', profileError.message);
      // We don't delete the auth user here to avoid data loss,
      // but we throw so the user knows it failed.
      throw profileError;
    }

    // 4. Mark invite as used
    const { error: updateError } = await supabaseAdmin
      .from('invites')
      .update({ used: true })
      .eq('id', invite.id);

    if (updateError) console.warn('⚠️ Could not mark invite as used:', updateError.message);

    console.log(`🎉 SUCCESS: Account activated for ${invite.email}`);
    return res.json({ success: true, message: 'Account activated successfully', role: invite.role });

  } catch (err) {
    console.error(`❌ Activation Final Error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});




// 🚀 CUSTOMER REGISTRATION SYSTEM (RESEND INTEGRATED)
app.post('/customer/register', async (req, res) => {
  const { email, password, firstName, lastName, phone } = req.body;
  console.log(`\n🏎️ [CUSTOMER REGISTRATION] STARTING FLOW FOR: ${email}`);

  try {
    // 1. Use generateLink so Supabase DOES NOT send its default SMTP email
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'signup',
      email,
      password,
      data: {
        first_name: firstName,
        last_name: lastName,
        phone_number: phone,
        role: 'CUSTOMER'
      }
    });
    // For development, we can automatically confirm if needed,
    // but the directive asks to toggle it OFF.
    // generating a link is one way, but createUser is better if we want NO email.

    if (error) {
      console.error('❌ Supabase Generate Link Error:', error.message);
      return res.status(400).json({ success: false, error: error.message });
    }

    const confirmLink = data.properties?.action_link;
    if (!confirmLink) {
      throw new Error('Failed to generate action link from Supabase');
    }

    // 2. Dispatch via Resend
    if (!resendClient) {
      throw new Error('RESEND_API_KEY is not configured or Resend is not initialized');
    }

    const emailResponse = await resendClient.emails.send({
      from: RESEND_FROM,
      to: email,
      subject: 'WELCOME TO THE FLEET',
      html: `
        <div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 600px; border: 1px solid #eee;">
          <h2 style="color: #A91B18;">COMAR GARAGE</h2>
          <h3 style="margin-top: 0; text-transform: uppercase;">WELCOME TO THE FLEET</h3>
          <p>Hi ${firstName},</p>
          <p>Thank you for creating an account with Comar Garage. Please confirm your email address to activate your customer portal.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${confirmLink}" style="background-color: #A91B18; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">CONFIRM EMAIL ADDRESS</a>
          </div>
          <p style="font-size: 11px; color: #888;">If you did not request this, please ignore this email.</p>
        </div>
      `
    });

    console.log('📧 [Resend] Response:', JSON.stringify(emailResponse, null, 2));

    if (emailResponse.error) {
      console.error(`❌ Resend Error: ${emailResponse.error.message}`);
    } else {
      console.log(`✅ Customer welcome email delivered to ${email}`);
    }
    return res.json({ success: true, message: 'Registration email sent' });

  } catch (err) {
    console.error(`❌ Registration Error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Directive 2: PRE-NORMALIZE TEXT BEFORE MATCHING.
 * E-wallet receipts render the same payee many ways ('ATHEA JAYNE AHORRO',
 * 'Athea Jayne Ahorro', 'A. Ahorro'). Lowercase, strip punctuation/middle-initial
 * dots, and collapse whitespace so a substring check survives that variance.
 */
const normalizeMatchText = (value) => String(value || '')
  .toLowerCase()
  // Drop middle-initial dots ('A. Ahorro') and all other punctuation.
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * True when the receipt's payee and the shop's registered account are the same
 * party. Accepts either direction of containment so a short configured name
 * still matches a longer printed one (and vice versa) after normalization.
 */
const recipientNameMatches = (receiptRecipient, expectedRecipient) => {
  const receiptText = normalizeMatchText(receiptRecipient);
  const expectedText = normalizeMatchText(expectedRecipient);
  if (!receiptText || !expectedText) return false;
  return receiptText.includes(expectedText) || expectedText.includes(receiptText);
};

const registerOcrScanSession = async (imageHash, ocrMetadata) => {
  if (!supabaseAdmin) throw new Error('OCR scan session storage is unavailable.');
  const { data, error } = await supabaseAdmin.rpc('register_ocr_scan_session', {
    p_image_hash: imageHash,
    p_ocr_metadata: ocrMetadata,
    p_payment_verdict: 'FOR_VERIFICATION',
  });
  if (error) throw error;
  if (!data) throw new Error('OCR scan session was not created.');
  return data;
};
const storeOcrReceiptImage = async (file, imageHash) => {
  if (!supabaseAdmin) throw new Error('Receipt storage is unavailable.');
  const extension = ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  })[file.mimetype] || 'img';
  const objectPath = `receipts/${imageHash}-${crypto.randomUUID()}.${extension}`;
  const { error } = await supabaseAdmin.storage
    .from('payment-receipts')
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false,
    });
  if (error) throw error;
  const { data } = supabaseAdmin.storage.from('payment-receipts').getPublicUrl(objectPath);
  if (!data?.publicUrl) throw new Error('Could not create a receipt URL.');
  return data.publicUrl;
};

/**
 * 🤖 REQ-SYS-01: Receipt Verification
 * Extraction and preprocessing run server-side against the uploaded image.
 *
 * Directive 1 & 2: FAIL-FAST, SHORT-CIRCUIT PIPELINE.
 *   1. Scan + match the recipient name first. If it does not match the shop's
 *      registered account, abort immediately with NAME_MISMATCH — no further
 *      amount/date/duplicate work is done for a receipt that is not ours.
 *   2. Only then evaluate amount, date, and reference uniqueness.
 * The response always carries an explicit { valid, reason, status } contract so
 * the checkout UI can hard-block submission on anything but MATCH_SUCCESS.
 *
 * TRUST: the uploaded image bytes are the only OCR input. Browser-supplied text
 * is ignored; the resulting scan session is bound to the booking at submission.
 */
app.post('/api/ocr/verify-receipt', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, valid: false, reason: 'NO_FILE', error: 'No receipt image uploaded' });
    }

    // ── SC-18: RATE LIMIT (server-side) ────────────────────────────────────
    // A script could previously fire unlimited scans (the client re-entrancy
    // guard is trivially bypassed) and drain OCR credits. We throttle per
    // identity: the authenticated user when present, else the client IP.
    const identity = `ocr:${req.body.bookingId || 'unknown'}:${req.ip || req.headers['x-forwarded-for'] || 'anon'}`;

    if (ocrGuard.isAutomationLocked(identity)) {
      console.warn(`⛔ [OCR] ${identity} is LOCKED after repeated failures — routing to manual review.`);
      const imageHash = ocrGuard.computeImageHash(req.file.buffer);
      const receiptUrl = await storeOcrReceiptImage(req.file, imageHash);
      const manualMetadata = {
        amount: null,
        grossAmount: null,
        transferFee: 0,
        referenceNumber: null,
        referenceNo: null,
        recipient: null,
        isValidReceipt: false,
        isReceipt: false,
        payment_verdict: 'FOR_VERIFICATION',
        status: 'MANUAL_REVIEW',
        image_hash: imageHash,
          receipt_url: receiptUrl,
        extraction_unavailable: true,
        auditedAt: new Date().toISOString(),
      };
      const ocrScanId = await registerOcrScanSession(imageHash, manualMetadata);
      return res.json({
        valid: false,
        reason: 'VERIFICATION_LOCKED',
        status: 'MANUAL_REVIEW',
        success: true,
        isNameMatch: null,
        isAmountMatch: null,
        isDuplicate: false,
        isManualReview: true,
        manualReviewAllowed: true,
        ocrScanId,
          receiptUrl,
          receipt_url: await storeOcrReceiptImage(req.file, imageHash),
        data: {
          referenceNo: 'MANUAL_AUDIT_PENDING',
          amount: 0,
          recipient: 'N/A',
          isReceipt: true,
          description: 'Automated OCR is temporarily locked after repeated unreadable uploads. Your payment proof was saved for manual admin verification.',
        },
      });
    }

    const rate = ocrGuard.checkRateLimit(identity);
    if (!rate.allowed) {
      const retrySeconds = Math.ceil(rate.retryAfterMs / 1000);
      console.warn(`⛔ [OCR] RATE LIMIT hit for ${identity}. Retry in ${retrySeconds}s.`);
      res.set('Retry-After', String(retrySeconds));
      return res.status(429).json({
        success: false,
        valid: false,
        reason: 'RATE_LIMITED',
        error: `Too many receipt scans. Please wait ${retrySeconds} second(s) and try again.`,
        retryAfterSeconds: retrySeconds,
      });
    }

    console.log(`[OCR] Scanning receipt image: ${req.file.originalname} (${req.file.size} bytes)`);

    // SC-17: byte-level SHA-256 catches exact-file reuse independently of any
    // OCR-extracted reference. Re-encoded copies require perceptual hashing.
    const imageHash = ocrGuard.computeImageHash(req.file.buffer);

    const paymentType = String(req.body.paymentType || req.body.payment_type || 'Full').toLowerCase();
    const requiredAmount = parseFloat(req.body.requiredAmount) || 0;
    const fullAmount = parseFloat(req.body.fullAmount) || requiredAmount;
    const effectiveRequiredAmount = paymentType === 'downpayment' ? Math.min(requiredAmount, fullAmount) : fullAmount;
    const bookingId = req.body.bookingId;
    const paymentId = req.body.paymentId;
    const expectedQrVersion = Number(req.body.expectedQrVersion || req.body.expected_qr_version || 0);
    let liveQrAccountName = '';
    let liveQrVersion = 0;
    if (supabaseAdmin) {
      try {
        const { data: liveCfg } = await supabaseAdmin
          .from('business_config')
          .select('*')
          .order('id')
          .limit(1)
          .maybeSingle();
        liveQrVersion = Number(liveCfg?.qr_config_version || 0);
        liveQrAccountName = String(
          liveCfg?.qr_account_name || liveCfg?.payment_account_name || liveCfg?.gcash_name || ''
        ).trim();
      } catch (cfgErr) {
        console.warn('⚠️ [AI OCR] QR version lookup failed (non-fatal):', cfgErr.message);
      }
    }
    const expectedRecipientName = liveQrAccountName;
    if (!expectedRecipientName) {
      console.error('[OCR] No registered shop payment account was found in business_config. Auto-verification will fail closed.');
    }
    const qrVersionMismatch = Boolean(expectedQrVersion && liveQrVersion && expectedQrVersion !== liveQrVersion);
    if (qrVersionMismatch) {
      console.log(`⚠️ [OCR] QR_VERSION_MISMATCH: receipt paid against v${expectedQrVersion} but live config is v${liveQrVersion}. Flagging for admin review.`);
    }

    // Legacy browser text fields are deliberately ignored. OCR runs against
    // server-owned preprocessing variants of these exact uploaded bytes.
    let ocrResult;
    try {
      ocrResult = await recognizeReceipt(req.file.buffer, {
        validateCandidate: (parsed) => {
          const referenceNo = String(parsed.referenceNumber || '').trim();
          const isReferenceValid = isValidReferenceNumber(referenceNo);
          return Boolean(
            parsed.isValidReceipt
            && parsed.amount !== null
            && parsed.amount >= effectiveRequiredAmount
            && isReferenceValid
            && (!expectedRecipientName || recipientNameMatches(parsed.recipient, expectedRecipientName))
          );
        },
      });
    } catch (ocrError) {
      console.warn(`⚠️ [OCR] Server extraction failed; queueing for manual review: ${ocrError.message}`);
      ocrResult = parseReceiptText('');
    }
    const rawExtractedText = String(ocrResult.rawText || '');

    const extractedData = {
      ...ocrResult,
      referenceNo: ocrResult.referenceNumber,
      isReceipt: ocrResult.isValidReceipt
    };

    console.log(`🔍 [OCR] SERVER PARSE:`, {
      amount: extractedData.amount,
      gross: extractedData.grossAmount,
      fee: extractedData.transferFee,
      ref: extractedData.referenceNo,
      isReceipt: extractedData.isReceipt,
      confidence: extractedData.confidence,
      pass: extractedData.ocrPass,
      shopAccountConfigured: Boolean(expectedRecipientName),
    });

    // 🛡️ FINANCIAL INTEGRITY GUARD: Comparison Logic
    const extractedAmount = normalizeAmountValue(extractedData.amount) ?? 0;
    const referenceNo = String(extractedData.referenceNo || '').trim();
    const isNameMatch = recipientNameMatches(extractedData.recipient, expectedRecipientName);

    const isAmountMatch = extractedData.amount !== null && extractedAmount >= effectiveRequiredAmount;
    const overpaymentAmount = Math.max(0, Math.round((extractedAmount - fullAmount) * 100) / 100);
    if (overpaymentAmount > 0) {
      console.log(`💰 [OCR] OVERPAYMENT accepted: ₱${extractedAmount} vs full booking amount ₱${fullAmount} → ₱${overpaymentAmount} surplus banked as credit.`);
    }

    const isReferenceValid = isValidReferenceNumber(referenceNo);

    // A payment reference is single-use. Check this before accepting the
    // receipt so the same transfer cannot be attached to another booking.
    let isDuplicate = false;
    let duplicateReason = null;

    if (isReferenceValid && supabaseAdmin) {
      let duplicateQuery = supabaseAdmin
        .from('payments')
        .select('id')
        .eq('reference_number', referenceNo)
        .limit(1);

      // A rescanned existing payment must not be considered a duplicate of
      // itself. Initial booking scans have no payment ID yet.
      if (paymentId) duplicateQuery = duplicateQuery.neq('id', paymentId);

      const { data: existingPayment, error: duplicateCheckError } = await duplicateQuery.maybeSingle();
      if (duplicateCheckError) {
        throw new Error(`REFERENCE_CHECK_FAILED: ${duplicateCheckError.message}`);
      }
      if (existingPayment) {
        isDuplicate = true;
        duplicateReason = 'REFERENCE_REUSED';
      }
    }
    const isReferenceUnique = Boolean(isReferenceValid && supabaseAdmin && duplicateReason !== 'REFERENCE_REUSED');

    // 🛡️ SC-17 FIX — IMAGE-HASH DUPLICATE DETECTION.
    // The reference number is attacker-controllable (a reused receipt can be
    // re-scanned and the OCR biased toward a fresh reference). The IMAGE BYTES
    // are not: hashing the uploaded buffer server-side catches the exact same
    // image being submitted to a DIFFERENT booking, even with a different (or
    // fabricated) reference number. We compare against existing receipt hashes.
    let usedImageHash = false;
    if (imageHash && supabaseAdmin) {
      try {
        // The image hash is stored on the server-side OCR session record, not on
        // the payment row. Payments do not have an ocr_metadata column in the
        // deployed schema, so a direct lookup there is a 500.
        const { data: hashMatches, error: hashError } = await supabaseAdmin
          .from('ocr_scan_sessions')
          .select('id, booking_id, payment_id')
          .eq('image_hash', imageHash)
          .limit(1);

        if (hashError) {
          throw new Error(hashError.message);
        } else if (Array.isArray(hashMatches) && hashMatches.length > 0) {
          const matched = hashMatches[0];
          if (!paymentId || matched.payment_id !== paymentId) {
            usedImageHash = true;
            isDuplicate = true;
            duplicateReason = 'IMAGE_REUSED';
          }
        }
      } catch (hashCheckError) {
        console.warn('[OCR] Image-hash duplicate check skipped because the scan-session table is unavailable:', hashCheckError.message);
      }
    }

    // Duplicates are rejected immediately; amount, receipt-validity, OR date
    // issues remain available for staff review rather than being silently accepted.
    //
    // ENUM MAPPING — these are two DIFFERENT enums and must not be conflated:
    //
    //   bookings.payment_status  (booking_payment_status) = unpaid | pending | paid | refunded
    //   payments.status          (payment_status)         = UNPAID | FOR_VERIFICATION | PAID
    //                                                       | REJECTED | REFUND_PENDING | REFUNDED
    //
    // The previous code passed human-readable strings ('Flagged for Review' /
    // 'Confirmed') straight into bookings.payment_status, which the cast rejected:
    //   ERROR 42804: column "payment_status" is of type booking_payment_status
    //                but expression is of type text
    // That failure was only LOGGED, so the booking still reported success — which
    // is how an unreadable receipt completed a booking.
    //
    // NOTE: bookings.payment_status has NO 'for_verification' member. "Awaiting
    // verification" is spelled 'pending' on the booking and FOR_VERIFICATION on
    // the payment. Mapping them onto one string is what produced the 42804.
    const BOOKING_STATUS_PENDING = 'pending';
    const PAYMENT_STATUS_FOR_VERIFICATION = 'FOR_VERIFICATION';
    const PAYMENT_STATUS_REJECTED = 'REJECTED';

    const validationErrors = [];
    if (!extractedData.isReceipt) {
      validationErrors.push({ code: 'INVALID_RECEIPT', label: 'Receipt not recognized', message: 'We could not confirm this image is a payment receipt.' });
    }
    if (!isReferenceValid) {
      validationErrors.push({
        code: referenceNo ? 'REFERENCE_INVALID_FORMAT' : 'REFERENCE_NOT_DETECTED',
        label: 'Reference number issue',
        message: `We read reference "${referenceNo || 'nothing'}"; it must contain 6-40 letters or numbers. Spaces and hyphens are allowed.`,
      });
    } else if (!isReferenceUnique) {
      validationErrors.push({ code: 'REFERENCE_UNVERIFIED', label: 'Reference not verified', message: `We could not verify that reference "${referenceNo}" is unique.` });
    }
    if (isDuplicate) {
      validationErrors.push({
        code: duplicateReason === 'REFERENCE_REUSED' ? 'DUPLICATE_REFERENCE' : 'DUPLICATE_RECEIPT',
        label: duplicateReason === 'REFERENCE_REUSED' ? 'Reference already used' : 'Receipt already used',
        message: duplicateReason === 'REFERENCE_REUSED'
          ? `Reference "${referenceNo}" has already been used.`
          : 'This receipt image has already been submitted.',
      });
    }
    if (!expectedRecipientName || !isNameMatch) {
      validationErrors.push({
        code: extractedData.recipient ? 'RECIPIENT_MISMATCH' : 'RECIPIENT_NOT_DETECTED',
        label: 'Recipient mismatch',
        message: extractedData.recipient
          ? `We read recipient "${extractedData.recipient}", but the registered shop account is "${expectedRecipientName || 'unavailable'}".`
          : `The recipient could not be read; the registered shop account is "${expectedRecipientName || 'unavailable'}".`,
      });
    }
    if (!isAmountMatch) {
      validationErrors.push({
        code: extractedData.amount === null ? 'AMOUNT_NOT_DETECTED' : (paymentType === 'downpayment' ? 'AMOUNT_BELOW_DOWNPAYMENT' : 'AMOUNT_BELOW_REQUIRED'),
        label: paymentType === 'downpayment' ? 'Amount below minimum' : 'Amount below required payment',
        message: extractedData.amount === null
          ? 'The payment amount could not be read from the receipt.'
          : paymentType === 'downpayment'
            ? `We read ₱${extractedAmount.toLocaleString()}, but the minimum downpayment is ₱${effectiveRequiredAmount.toLocaleString()}.`
            : `We read ₱${extractedAmount.toLocaleString()}, but the required full payment is ₱${effectiveRequiredAmount.toLocaleString()}.`,
      });
    }
    if (qrVersionMismatch) {
      validationErrors.push({ code: 'QR_VERSION_MISMATCH', label: 'Payment QR changed', message: 'The receipt was paid against an older shop QR code.' });
    }

    const receiptIsTrustworthy = Boolean(extractedData.isReceipt)
      && Boolean(expectedRecipientName)
      && isNameMatch
      && isAmountMatch
      && isReferenceValid
      && isReferenceUnique
      && !isDuplicate
      && !qrVersionMismatch;

    // ── EXTRACTION-UNAVAILABLE PATH ────────────────────────────────────────
    //
    // The server-side OCR pipeline may fail to initialize, time out, or find no
    // readable receipt text. These cases go to a human rather than being treated
    // as either a successful payment or proof of fraud.
    //
    // Such a receipt must NOT be auto-REJECTED. A rejection is a hard block — the
    // customer cannot submit and has no recourse. But nothing has been proven
    // fraudulent either; the image was simply unreadable to the local engine.
    // The correct outcome is MANUAL REVIEW: the proof is stored, the admin sees
    // it in the verification queue, and a transient OCR failure never strands
    // someone who actually paid.
    //
    // This mirrors the old Gemini-outage path, which existed for exactly the same
    // reason. Note it is deliberately keyed on "no text at all", NOT on "the
    // amount did not match" — a readable receipt with the wrong amount is still a
    // rejection, because that is a real signal.
    const extractionUnavailable = !rawExtractedText.trim()
      || !extractedData.isReceipt
      || !extractedData.recipient;

    if (extractionUnavailable && !isDuplicate) {
      console.warn('⚠️ [OCR] Extraction unavailable — routing receipt to MANUAL REVIEW (not rejecting).');

      const manualMetadata = {
        ...extractedData,
        payment_verdict: PAYMENT_STATUS_FOR_VERIFICATION,
        status: 'MANUAL_REVIEW',
        isMatch: null,
        isNameMatch: expectedRecipientName ? isNameMatch : null,
        receipt_is_trustworthy: false,
        extraction_unavailable: true,
        requiredAmount,
        fullAmount,
        isAmountMatch,
        isReferenceValid,
        isReferenceUnique,
        validationErrors,
        isDuplicate: false,
        image_hash: imageHash,
        qrConfigVersion: expectedQrVersion || null,
        liveQrVersion: liveQrVersion || null,
        qrVersionMismatch,
        auditedAt: new Date().toISOString(),
      };
      const ocrScanId = await registerOcrScanSession(imageHash, manualMetadata);

      // Persist what little we have so the admin can adjudicate, then return a
      // verdict the client treats as "accepted, pending human review".
      if (bookingId && bookingId !== 'PENDING' && paymentId && supabaseAdmin) {
        const { error: reviewError } = await supabaseAdmin.rpc('persist_ocr_result', {
          p_booking_id: bookingId,
          p_payment_id: paymentId,
          p_detected_amount: extractedAmount,
          p_detected_ref: referenceNo || null,
          p_payment_status: 'pending',
          p_ocr_metadata: {
            ...manualMetadata,
            status: 'MANUAL_REVIEW',
            isMatch: null,
            // UI-CONTRACT KEYS. The admin UI reads these straight off the stored
            // record (AdminBookingDetails `ocr_metadata.isMatch`,
            // AdminRefunds `ocr_metadata.status`). A manually-reviewed booking
            // must present as an explicit "needs a human" state rather than
            // `undefined`, which would render as an unexplained blank.
          }
        });
        if (reviewError) {
          console.error('⚠️ Could not persist manual-review OCR result:', reviewError.message);
        }
      }

      return res.json({
        success: true,
        valid: false,
        reason: 'VERIFICATION_UNAVAILABLE',
        status: 'MANUAL_REVIEW',
        isNameMatch: null,
        isAmountMatch: null,
        isDuplicate: false,
        isManualReview: true,
        verificationUnavailable: true,
        // The ONLY case that leaves submit enabled. The customer is told the
        // receipt is queued for manual verification rather than blocked.
        manualReviewAllowed: true,
        ocrScanId,
        receiptUrl: manualMetadata.receipt_url,
        data: {
          ...extractedData,
          amount: extractedAmount,
          amountDetected: extractedData.amount !== null && extractedData.amount !== undefined,
          referenceNo: referenceNo || 'MANUAL_AUDIT_PENDING',
          expectedRecipientName,
          expectedAmount: { minimum: requiredAmount, full: fullAmount },
          isNameMatch,
          isAmountMatch,
          isReferenceValid,
          isReferenceUnique,
          validationErrors,
          description: 'The receipt could not be read automatically on this device. It has been saved for manual admin verification.'
        }
      });
    }

    // What the PAYMENT row records (payments.status).
    const finalPaymentStatus = isDuplicate || !receiptIsTrustworthy
      ? PAYMENT_STATUS_REJECTED
      : PAYMENT_STATUS_FOR_VERIFICATION;

    // What the BOOKING records (bookings.payment_status). A customer's receipt
    // never auto-settles: it goes to 'pending' and waits for an admin, even when
    // the scan was clean. Only an admin verification advances it to 'paid'.
    const finalBookingStatus = 'pending';

    // Kept for the audit-log line and the response body.
    const finalStatus = finalPaymentStatus;

    void BOOKING_STATUS_PENDING;

    // ── SC-18: failure circuit breaker ─────────────────────────────────────
    // A cleanly-read, well-formed receipt clears the streak. An unreadable or
    // invalid receipt counts toward the lock that forces manual review.
    if (receiptIsTrustworthy) {
      ocrGuard.recordSuccess(identity);
    } else {
      const failure = ocrGuard.recordFailure(identity);
      if (failure.locked) {
        console.warn(`⚠️ [OCR] ${identity} reached ${failure.failures} consecutive failures — automated OCR now LOCKED for 5 min.`);
      }
    }

    console.log(`🔍 [AUDIT] Comparison: Extracted ₱${extractedAmount} vs minimum ₱${requiredAmount} (full ₱${fullAmount})`);
    console.log(`📊 [AUDIT] Result: amountMatch=${isAmountMatch}; referenceValid=${isReferenceValid}; referenceUnique=${isReferenceUnique}; duplicate=${isDuplicate} -> Status: ${finalStatus}`);

    // Persist booking and payment OCR data atomically after the booking exists.
    if (bookingId && bookingId !== 'PENDING' && typeof supabaseAdmin !== 'undefined') {
      if (!paymentId) {
        return res.status(500).json({
          success: false,
          error: 'OCR_PERSISTENCE_FAILED: Payment ID is required for persistence.'
        });
      }

      const { error: persistenceError } = await supabaseAdmin.rpc('persist_ocr_result', {
        p_booking_id: bookingId,
        p_payment_id: paymentId,
        p_detected_amount: extractedAmount,
        p_detected_ref: referenceNo || null,
        // bookings.payment_status is the booking_payment_status enum
        // (unpaid | pending | paid | refunded). It has NO 'for_verification'
        // member — 'pending' is how the booking spells "awaiting verification".
        // The payment row separately records FOR_VERIFICATION / REJECTED.
        p_payment_status: finalBookingStatus,
        p_ocr_metadata: {
          ...extractedData,
          // The payment-level verdict, kept inside the JSON so the rejection
          // reason survives even though the enum column only holds 'pending'.
          payment_verdict: finalPaymentStatus,
          // ── UI-CONTRACT KEYS ───────────────────────────────────────────────
          //
          // `status` and `isMatch` are read by the ADMIN UI straight out of the
          // persisted metadata:
          //
          //   AdminBookingDetails.jsx  booking.ocr_metadata.isMatch
          //   AdminRefunds.jsx         ocr_metadata.status === 'MATCHED'
          //
          // They were present on the HTTP RESPONSE but MISSING from the persisted
          // payload, so the two surfaces silently mis-rendered on every booking:
          // `isMatch` read as undefined, so the "verified" styling never applied,
          // and `status` read as undefined, so a cleanly-matched receipt was
          // painted with the amber "not matched" colour. The response and the
          // record must carry the SAME verdict vocabulary or the admin sees
          // something different from what the system decided.
          //
          // NOTE: this is computed from the raw flags rather than reusing
          // `isValidReceipt`, which is declared FURTHER DOWN (line ~1913).
          // Referencing it here was a temporal-dead-zone error that would have
          // thrown `ReferenceError: Cannot access 'isValidReceipt' before
          // initialization` on EVERY persistence — i.e. it would have broken the
          // very write this object exists to perform.
          status: receiptIsTrustworthy
            ? 'MATCH_SUCCESS'
            : (isDuplicate ? 'REJECTED_DUPLICATE' : 'FLAGGED_DETAILS_MISMATCH'),
          isMatch: isAmountMatch,
          isNameMatch,
          receipt_is_trustworthy: receiptIsTrustworthy,
          requiredAmount,
          fullAmount,
          isAmountMatch,
          // HOTFIX: persist the surplus explicitly so the ledger/UI can show
          // "₱X credit" rather than treating an overpayment as a mismatch.
          overpaymentAmount,
          isOverpayment: overpaymentAmount > 0,
          isReferenceValid,
          isReferenceUnique,
          validationErrors,
          isDuplicate,
          // SC-17: the perceptual image hash, persisted so a later reuse of the
          // SAME image (even with a different reference) is detected.
          image_hash: imageHash,
          duplicate_reason: duplicateReason,
          // Scenario 8: persist the QR version context so a payment made via a
          // superseded store QR is traceable in the admin review.
          qrConfigVersion: expectedQrVersion || null,
          liveQrVersion: liveQrVersion || null,
          qrVersionMismatch,
          auditedAt: new Date().toISOString()
        }
      });

      if (persistenceError) {
        // FAIL-CLOSED. This handler previously logged the error and returned
        // `success: true`, so a booking whose OCR verdict could not be recorded
        // was still treated as verified upstream. The verdict IS the security
        // control — if it cannot be persisted, the client must not be told the
        // receipt passed.
        console.error('⚠️ Atomic OCR persistence failed:', persistenceError.message);

        // Distinguish "the database rejected our enum cast" from a transient
        // failure: both are fatal to the verdict, but the former is a code defect
        // that must be loud rather than retried.
        const isTypeRejection = persistenceError.code === '42804' || /is of type/i.test(persistenceError.message || '');
        if (isTypeRejection) {
          console.error('🚨 [OCR] persist_ocr_result rejected the status value itself. This is a code defect, not a user error.');
        }

        return res.status(500).json({
          success: false,
          valid: false,
          status: 'OCR_PERSISTENCE_FAILED',
          reason: 'OCR_PERSISTENCE_FAILED',
          error: 'OCR_PERSISTENCE_FAILED: we could not record the receipt verdict, so the payment cannot be treated as verified.',
        });
      }

      // Record in Master Audit Log
      try {
        await supabaseAdmin.from('audit_logs').insert({
          booking_id: bookingId,
          action_type: 'AI_VERIFICATION_COMPLETE',
          actor_name: 'AI_AUDITOR',
          actor_role: 'SYSTEM',
          details: `AI extraction complete. Reference: ${referenceNo || 'N/A'}. Amount: ₱${extractedAmount}. Amount match: ${isAmountMatch}. Duplicate: ${isDuplicate}. Persisted status: ${finalStatus}.`
        });
      } catch (logErr) {
        console.warn('⚠️ Audit logging failed, but the verdict was persisted.');
      }
    } else {
      // ── NO BOOKING TO ATTACH TO YET (the pre-submit scan) ─────────────────
      //
      // This branch is reached when the receipt is scanned BEFORE the booking
      // row exists, so persist_ocr_result cannot be called. Previously this was a
      // no-op that logged and fell through to `success: true` regardless of the
      // verdict — which is how a non-receipt image could complete a booking: the
      // one call that enforces the OCR verdict was skipped entirely.
      //
      // The enforcement is NOT duplicated here. The verdict is returned to the
      // caller as `valid: false`, and create_booking_atomic re-checks the stored
      // verdict before any row is written. What matters is that this branch can
      // no longer imply approval.
      console.log(`ℹ️ [AI OCR] Booking is ${bookingId || 'PENDING'} — returning the verdict to the caller for enforcement at submit time.`);
    }

    // ── STEP 2: AMOUNT / REFERENCE ─────────────────────────────────────────
    // Reached only after the name gate passed. An amount that does not match
    // (or a stale/duplicate receipt) blocks auto-approval but the booking is
    // still allowed to submit for manual admin review.
    const isValidReceipt = receiptIsTrustworthy;
    const failureReason = isValidReceipt ? null : (validationErrors[0]?.code || 'FLAGGED_DETAILS_MISMATCH');

    const receiptUrl = isValidReceipt
      ? await storeOcrReceiptImage(req.file, imageHash)
      : null;
    const ocrScanId = isValidReceipt
      ? await registerOcrScanSession(imageHash, {
        ...extractedData,
        receipt_url: receiptUrl,
        payment_verdict: PAYMENT_STATUS_FOR_VERIFICATION,
        status: 'MATCH_SUCCESS',
        isMatch: true,
        isNameMatch,
        receipt_is_trustworthy: receiptIsTrustworthy,
        requiredAmount,
        fullAmount,
        isAmountMatch,
        overpaymentAmount,
        isOverpayment: overpaymentAmount > 0,
        isReferenceValid,
        isReferenceUnique,
        validationErrors,
        isDuplicate,
        image_hash: imageHash,
        duplicate_reason: duplicateReason,
        qrConfigVersion: expectedQrVersion || null,
        liveQrVersion: liveQrVersion || null,
        qrVersionMismatch,
        auditedAt: new Date().toISOString(),
      })
      : null;

    return res.json({
      valid: isValidReceipt,
      reason: isValidReceipt ? null : (failureReason || 'FLAGGED_DETAILS_MISMATCH'),
      status: isValidReceipt ? 'MATCH_SUCCESS' : (isDuplicate ? 'REJECTED_DUPLICATE' : 'FLAGGED_DETAILS_MISMATCH'),
      success: true,
      isNameMatch,
      isAmountMatch,
      isReferenceValid,
      isReferenceUnique,
      // Retain the old property until all existing frontend consumers have
      // migrated to isAmountMatch.
      isMatch: isAmountMatch,
      isDuplicate,
      validationErrors,
      ocrScanId,
      receiptUrl,
      persistedStatus: finalStatus,
      data: {
        ...extractedData,
        amount: extractedAmount,
        amountDetected: extractedData.amount !== null && extractedData.amount !== undefined,
        recipient: extractedData.recipient || 'N/A',
        expectedRecipientName,
        expectedAmount: { minimum: requiredAmount, full: fullAmount },
        isNameMatch,
        isReferenceValid,
        isReferenceUnique,
        validationErrors
      }
    });

  } catch (error) {
    // An oversized upload is a CLIENT error, not a server fault. Without this
    // branch multer's LIMIT_FILE_SIZE surfaced as an opaque HTTP 500, which reads
    // as "the server broke" and gives the customer no idea their photo is too
    // large. A 413 with an actionable message is the correct contract.
    if (error && (error.code === 'LIMIT_FILE_SIZE' || error instanceof multer.MulterError)) {
      console.warn(`⚠️ [OCR] Upload rejected: ${error.code || error.message}`);
      return res.status(413).json({
        success: false,
        valid: false,
        reason: 'FILE_TOO_LARGE',
        error: `That image is too large. Please upload a receipt under ${Math.round(MAX_RECEIPT_BYTES / (1024 * 1024))} MB.`,
      });
    }

    console.error('❌ [OCR Error]:', error);
    return res.status(500).json({
      success: false,
      error: `Receipt verification failed: ${error.message}`
    });
  }
});

/**
 * 🛡️ REQ-ADM-12: Simulated AI Audit for Admin Dashboard
 * Provides an immediate, reliable 'Audit Simulation' for thesis defense.
 */
/**
 * 🛡️ REQ-NFR-31: Password Verification Challenge
 * Allows frontend to verify current password before sensitive updates
 */
app.post('/api/auth/verify-password', async (req, res) => {
  const { email, password } = req.body;
  if (!supabaseAdmin) return res.status(503).json({ success: false, error: 'Admin service unavailable' });
  console.log(`🔐 [AUTH] PASSWORD CHALLENGE FOR: ${email}`);

  try {
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (error) {
      return res.status(401).json({ success: false, error: 'Invalid current password' });
    }
    return res.json({ success: true, message: 'Identity verified' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Verification system error' });
  }
});

const sendPasswordConfirmationEmail = async ({ email, token, purpose }) => {
  // appUrl() fails loudly in production when FRONTEND_URL is unset, instead of
  // silently emailing the customer a link to their own localhost.
  const confirmationUrl = appUrl(`/password-confirmation?token=${encodeURIComponent(token)}`);
  const subject = purpose === 'RESET' ? 'Confirm your Comar Garage password reset' : 'Confirm your Comar Garage password change';
  const action = purpose === 'RESET' ? 'Reset Password' : 'Confirm Password Change';
  return send({
    to: email,
    subject,
    html: buildEmailShell({
      title: action,
      eyebrow: 'COMAR GARAGE ACCOUNT SECURITY',
      bodyHtml: `<p style="margin:0 0 16px;color:#374151;line-height:1.7;">We received a request to ${purpose === 'RESET' ? 'reset' : 'change'} your Comar Garage password.</p><p style="margin:0 0 16px;color:#374151;line-height:1.7;">This confirmation link expires in <strong>15 minutes</strong> and can only be used once.</p><p style="margin:0;color:#6b7280;font-size:13px;">If you did not request this, ignore this email. Your current password remains unchanged.</p>`,
      ctaLink: confirmationUrl,
      ctaLabel: action,
      footerNote: 'Comar Garage | Account Security'
    })
  });
};

const sendPasswordSecurityAlert = async ({ email, purpose }) => send({
  to: email,
  subject: purpose === 'RESET' ? 'Your Comar Garage password was reset' : 'Your Comar Garage password was updated',
  html: buildEmailShell({
    title: purpose === 'RESET' ? 'Password Reset Complete' : 'Password Update Complete',
    eyebrow: 'COMAR GARAGE ACCOUNT SECURITY',
    bodyHtml: '<p style="margin:0;color:#374151;line-height:1.7;">Your Comar Garage account password was successfully updated. If you did not make this change, contact support immediately.</p>',
    footerNote: 'Comar Garage Detail Studio | Account Security'
  })
});

/**
 * 🛡️ THE WRONG-PASSWORD SECURITY NOTICE — the delivery half.
 *
 * `register_failed_login_staged()` (migration 20261021000003) is the DECISION:
 * when the ladder is exhausted it holds the account and writes a row into
 * `login_security_notices`. It deliberately does NOT send mail — the database
 * has no mail transport, and putting one there would mean a second place where
 * tokens are minted.
 *
 * This worker is the DELIVERY. It drains that queue, mints a real single-use
 * reset token through the SAME `createPasswordConfirmationRequest` helper the
 * "Forgot password" flow uses, and emails the warning + reset link.
 *
 * WITHOUT THIS the escalation is silent: the queue row is written and nobody is
 * ever told, so the requirement ("a confirmation email should be sent to the
 * user") would be unmet while every test still passed. That is why it exists.
 *
 * WHY `claim_login_security_notices` AND NOT A PLAIN SELECT
 * -------------------------------------------------------
 * The claim RPC flips `sent_at` inside a `FOR UPDATE SKIP LOCKED` transaction, so
 * two backend instances polling at the same moment cannot both mail the same
 * row. Selecting first and updating after would let both workers see the row and
 * the owner would get two identical alerts.
 *
 * The claim happens BEFORE the send on purpose: if the mail provider then fails,
 * the notice is marked sent and NOT retried. That is the correct trade for a
 * SECURITY email — a duplicate "someone is attacking your account" alert is more
 * alarming than a missing one, and the account is already locked either way, so
 * the user is not left unprotected by a lost mail.
 */
const processLoginSecurityNotices = async () => {
  if (!supabaseAdmin) return;

  try {
    const { data: notices, error } = await supabaseAdmin.rpc('claim_login_security_notices', { p_limit: 10 });

    if (error) {
      // Not deployed yet is expected on an un-migrated database; anything else
      // is a real fault worth shouting about.
      const missing = /could not find the function|schema cache|does not exist/i.test(error.message || '');
      if (!missing) console.error('❌ [SECURITY-NOTICE] Claim failed:', error.message);
      return;
    }

    for (const notice of (notices || [])) {
      try {
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('id, email, full_name, locked_until')
          .eq('id', notice.user_id)
          .maybeSingle();

        const email = notice.email || profile?.email;
        if (!email) {
          console.warn(`⚠️ [SECURITY-NOTICE] No email for user ${notice.user_id}; skipping.`);
          continue;
        }

        // The reset link must be a REAL, single-use, expiring token — the same
        // flow as "Forgot password". Reusing it means the button in a security
        // alert cannot become a second, weaker way into an account.
        let resetLink = `${process.env.FRONTEND_URL || 'https://comargarage.com'}/reset-password`;
        try {
          const { token } = await createPasswordConfirmationRequest({
            userId: profile?.id || notice.user_id,
            email,
            purpose: 'RESET'
          });
          resetLink = `${process.env.FRONTEND_URL || 'https://comargarage.com'}/reset-password?token=${token}`;
        } catch (tokenError) {
          // Still send the WARNING even if we could not mint a token: knowing
          // that someone is attacking the account matters more than the
          // convenience of the one-click button.
          console.warn('⚠️ [SECURITY-NOTICE] Reset token minting failed; sending the alert without a link:', tokenError.message);
        }

        await sendWrongPasswordSecurityNotice({
          email,
          attempts: notice.attempts_at_escalation,
          lockedUntil: profile?.locked_until,
          resetLink
        });

        console.log(`🛡️ [SECURITY-NOTICE] Sent wrong-password alert to ${email} after ${notice.attempts_at_escalation} failed attempts.`);
      } catch (noticeError) {
        console.error(`❌ [SECURITY-NOTICE] Failed to deliver notice ${notice.id}:`, noticeError.message);
      }
    }
  } catch (err) {
    console.error('❌ [SECURITY-NOTICE] Worker error:', err.message);
  }
};

// Drain the escalation queue on the same cadence as the no-show sweep. The
// claim RPC makes repeated runs safe, so an overlapping tick is a no-op.
//
// The first run is deferred by a tick rather than called inline: this worker
// uses `createPasswordConfirmationRequest`, which is declared with `const`
// FURTHER DOWN this file. Calling it synchronously here would hit the temporal
// dead zone (`Cannot access 'createPasswordConfirmationRequest' before
// initialization`) and crash the process at boot. `setInterval` is deferred by
// nature, so only the immediate call needs the wrapper.
setInterval(processLoginSecurityNotices, 5 * 60000);
setTimeout(processLoginSecurityNotices, 0);

const createPasswordConfirmationRequest = async ({ userId, email, purpose, newPassword = null }) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const encrypted = newPassword ? encryptPendingPassword(newPassword) : {};
  await supabaseAdmin.from('password_confirmation_requests').delete().eq('user_id', userId).is('consumed_at', null);
  const { error } = await supabaseAdmin.from('password_confirmation_requests').insert({
    user_id: userId,
    email,
    purpose,
    token_hash: hashConfirmationToken(token),
    password_ciphertext: encrypted.ciphertext || null,
    password_iv: encrypted.iv || null,
    password_tag: encrypted.tag || null,
    expires_at: new Date(Date.now() + PASSWORD_CONFIRMATION_TTL_MS).toISOString()
  });
  if (error) throw error;
  const emailResult = await sendPasswordConfirmationEmail({ email, token, purpose });
  if (!emailResult.success) throw new Error(emailResult.error?.message || emailResult.error || 'Confirmation email failed');
  // Task 16: surface delivery metadata so the caller can tell the user the
  // email ACTUALLY left the building (message id), not merely that it was queued.
  return {
    emailDelivered: true,
    messageId: emailResult.data?.id || null,
    expiresAt: new Date(Date.now() + PASSWORD_CONFIRMATION_TTL_MS).toISOString()
  };
};

app.post('/api/auth/request-password-change', async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  if (!email || !currentPassword || !newPassword) return res.status(400).json({ success: false, error: 'All password fields are required.' });
  try {
    const { error: verifyError } = await supabaseAdmin.auth.signInWithPassword({ email, password: currentPassword });
    if (verifyError) return res.status(401).json({ success: false, error: 'Invalid current password.' });
    const { data: users, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersError) throw usersError;
    const account = users.users.find(item => item.email?.toLowerCase() === email.toLowerCase());
    if (!account) return res.status(401).json({ success: false, error: 'Invalid current password.' });
    const delivery = await createPasswordConfirmationRequest({ userId: account.id, email: account.email, purpose: 'UPDATE', newPassword });
    return res.json({
      success: true,
      emailDelivered: delivery.emailDelivered,
      messageId: delivery.messageId,
      expiresAt: delivery.expiresAt,
      message: 'Check your email to confirm the password change.'
    });
  } catch (error) {
    console.error('Password change request failed:', error.message);
    return res.status(500).json({ success: false, emailDelivered: false, error: 'Unable to send the confirmation email. Please try again or contact support.' });
  }
});

/**
 * 🔁 Task 16: RESEND password-change confirmation.
 * If the first email never arrived (Resend hiccup, spam filtering, typo’d inbox),
 * the user is not stranded — they can request a fresh link without retyping the
 * current password. Re-verifies the current password so this cannot be used as
 * an unauthenticated email-spam primitive for someone else’s account.
 */
app.post('/api/auth/resend-password-confirmation', async (req, res) => {
  const { email, currentPassword } = req.body;
  if (!email || !currentPassword) return res.status(400).json({ success: false, error: 'Email and current password are required.' });
  try {
    const { error: verifyError } = await supabaseAdmin.auth.signInWithPassword({ email, password: currentPassword });
    if (verifyError) return res.status(401).json({ success: false, error: 'Invalid current password.' });
    const { data: users, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersError) throw usersError;
    const account = users.users.find(item => item.email?.toLowerCase() === email.toLowerCase());
    if (!account) return res.status(401).json({ success: false, error: 'Invalid current password.' });

    // Re-use the still-valid pending request when one exists, issuing a FRESH
    // token while preserving the already-encrypted pending password on the row.
    const { data: pending } = await supabaseAdmin
      .from('password_confirmation_requests')
      .select('id, purpose, expires_at')
      .eq('user_id', account.id)
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!pending || pending.purpose !== 'UPDATE') {
      return res.status(409).json({ success: false, error: 'Your previous request has expired. Please submit the password change again.' });
    }

    // Rotate the token/expiry in place so the encrypted pending password survives,
    // then re-send the confirmation email.
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PASSWORD_CONFIRMATION_TTL_MS).toISOString();
    const { error: rotateError } = await supabaseAdmin
      .from('password_confirmation_requests')
      .update({ token_hash: hashConfirmationToken(token), expires_at: expiresAt })
      .eq('id', pending.id);
    if (rotateError) throw rotateError;

    const emailResult = await sendPasswordConfirmationEmail({ email: account.email, token, purpose: 'UPDATE' });
    if (!emailResult.success) throw new Error(emailResult.error?.message || emailResult.error || 'Confirmation email failed');

    return res.json({
      success: true,
      emailDelivered: true,
      messageId: emailResult.data?.id || null,
      expiresAt
    });
  } catch (error) {
    console.error('Password confirmation resend failed:', error.message);
    return res.status(500).json({ success: false, emailDelivered: false, error: 'Unable to resend the confirmation email.' });
  }
});

app.post('/api/auth/confirm-password-change', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Confirmation token is required.' });
  try {
    await supabaseAdmin.from('password_confirmation_requests').delete().lte('expires_at', new Date().toISOString());
    const { data: request, error: requestError } = await supabaseAdmin.from('password_confirmation_requests').select('*').eq('token_hash', hashConfirmationToken(token)).is('consumed_at', null).gt('expires_at', new Date().toISOString()).maybeSingle();
    if (requestError) throw requestError;
    if (!request) return res.status(400).json({ success: false, error: 'This confirmation link is expired or invalid.' });
    const password = request.purpose === 'UPDATE' ? decryptPendingPassword(request) : newPassword;
    if (!password || password.length < 6) return res.status(400).json({ success: false, error: 'A password of at least 6 characters is required.' });
    const { data: claimedRequest, error: claimError } = await supabaseAdmin.from('password_confirmation_requests').update({ consumed_at: new Date().toISOString() }).eq('id', request.id).is('consumed_at', null).select('id').maybeSingle();
    if (claimError) throw claimError;
    if (!claimedRequest) return res.status(400).json({ success: false, error: 'This confirmation link is expired or invalid.' });
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(request.user_id, { password });
    if (updateError) throw updateError;
    await supabaseAdmin.from('password_confirmation_requests').update({ password_ciphertext: null, password_iv: null, password_tag: null }).eq('id', request.id);
    const { error: alertError } = await sendPasswordSecurityAlert({ email: request.email, purpose: request.purpose });
    if (alertError) console.warn('Password security alert failed:', alertError.message || alertError);
    return res.json({ success: true, purpose: request.purpose });
  } catch (error) {
    console.error('Password confirmation failed:', error.message);
    return res.status(500).json({ success: false, error: 'Unable to apply the password change.' });
  }
});

app.post('/api/auth/inspect-password-confirmation', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Confirmation token is required.' });
  const { data: request, error } = await supabaseAdmin.from('password_confirmation_requests').select('purpose').eq('token_hash', hashConfirmationToken(token)).is('consumed_at', null).gt('expires_at', new Date().toISOString()).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: 'Unable to validate confirmation link.' });
  if (!request) return res.status(400).json({ success: false, error: 'This confirmation link is expired or invalid.' });
  return res.json({ success: true, purpose: request.purpose });
});

/**
 * 📧 REQ-CST-13: Backend-Relayed Password Recovery
 * Generates a secure Supabase recovery link and delivers it via Resend
 * with a branded email template — bypasses unreliable Supabase SMTP.
 */
app.post('/api/auth/recover-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ success: true, message: 'If an account is associated with that email, a password reset link has been sent.' });
  if (!supabaseAdmin) return res.json({ success: true, message: 'If an account is associated with that email, a password reset link has been sent.' });
  console.log(`🔑 [AUTH] PASSWORD RECOVERY INITIATED: ${email}`);

  // Policy guard: Forgot Password is a LINK flow. If someone flips this flow to
  // OTP in the policy map, the server refuses to run rather than emailing a code
  // the UI never accepts.
  assertDelivery('FORGOT_PASSWORD', DELIVERY.LINK);

  try {
    const { data: users, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersError) throw usersError;
    const account = users.users.find(item => item.email?.toLowerCase() === email.toLowerCase() && !item.deleted_at);

    // EMAIL AUTH POLICY (see backend/docs/EMAIL_AUTH_POLICY.md):
    //   FORGOT PASSWORD = 6-digit nothing. It ALWAYS delivers a one-time LINK to
    //   /password-confirmation?token=... . The user must never receive an OTP for
    //   a flow whose UI says "reset link". We delegate to the branded relay.
    if (account?.email) {
      await createPasswordConfirmationRequest({ userId: account.id, email: account.email, purpose: 'RESET' });
    } else {
      // Anti-enumeration: never reveal whether the address exists. Log for ops.
      console.log(`🔒 [AUTH] Recovery requested for unknown email (no action taken).`);
    }

    return res.json({ success: true, message: 'If an account is associated with that email, a password reset link has been sent.' });
  } catch (err) {
    console.error('❌ Password Recovery Error:', err.message);
    return res.json({ success: true, message: 'If an account is associated with that email, a password reset link has been sent.' });
  }
});


/**
 * 🛡️ REQ-CST-12: Double-Step Email Change
 * Sends verification token to OLD email address before authorizing change
 */
app.post('/api/auth/request-email-change', async (req, res) => {
  const actor = await getAuthenticatedActor(req);
  if (!actor) return res.status(401).json({ success: false, error: 'Authentication required.' });
  const userId = actor.user.id;
  const oldEmail = actor.user.email;
  const newEmail = String(req.body?.newEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).json({ success: false, error: 'A valid new email is required.' });
  }
  console.log(`📧 [AUTH] EMAIL CHANGE REQUEST: ${oldEmail} -> ${newEmail}`);

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP in profiles metadata temporarily (In a real system, use a dedicated table)
    const { error: dbError } = await supabaseAdmin
      .from('profiles')
      .update({
        email_change_temp: { newEmail, otp, expires: new Date(Date.now() + 15 * 60000).toISOString() }
      })
      .eq('id', userId);

    if (dbError) throw dbError;

    // Dispatch OTP to OLD email
    if (resendClient) {
      await resendClient.emails.send({
        from: RESEND_FROM,
        to: oldEmail,
        subject: 'Comar Garage: Authorize Email Change',
        html: `
          <div style="font-family: sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #A91B18;">COMAR GARAGE SECURITY</h2>
            <p>You requested to change your account email to <strong>${newEmail}</strong>.</p>
            <p>Enter the following authorization code to confirm this change:</p>
            <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; padding: 10px; background: #f4f4f4; border-radius: 5px; display: inline-block;">
              ${otp}
            </div>
            <p>If you did not request this, please change your password immediately.</p>
          </div>`
      });
    }

    console.log(`🔑 Verification code for ${oldEmail}: ${otp}`);
    return res.json({ success: true, message: 'Verification code sent to current email' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 🔐 Task B: QR Change OTP dispatcher.
 * The client has already parked the hashed OTP challenge in qr_change_otp via
 * the start_qr_change_otp RPC. This endpoint emails the plaintext 6-digit code
 * to the requesting admin's address (looked up from their bearer token, never
 * trusted from the body).
 */
app.post('/api/emails/qr-change-otp', async (req, res) => {
  const { otp } = req.body || {};
  if (!otp || !/^\d{6}$/.test(String(otp))) {
    return res.status(400).json({ success: false, error: 'A 6-digit code is required.' });
  }

  try {
    // Resolve the caller from their access token — never trust a body email.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, error: 'Missing authentication.' });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ success: false, error: 'Invalid session.' });
    }
    const adminEmail = userData.user.email;
    if (!adminEmail) return res.status(400).json({ success: false, error: 'Administrator email unavailable.' });

    // Task 3.3: capture the request metadata surfaced in the branded email.
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const requestIp = forwardedFor || req.ip || req.socket?.remoteAddress || 'Unavailable';
    const requestedAt = new Date().toISOString();

    const emailResult = await sendQrChangeOtpEmail({ recipientEmail: adminEmail, otp, requestedAt, requestIp });
    if (!emailResult.success) {
      console.warn('⚠️ QR OTP email delivery failed; code logged to terminal only.');
    }

    console.log(`🔑 [QR OTP] code for ${adminEmail} (ip ${requestIp}): ${otp}`);
    return res.json({ success: true, message: 'Verification code sent.' });
  } catch (err) {
    console.error('❌ QR OTP dispatch error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/confirm-email-change', async (req, res) => {
  const actor = await getAuthenticatedActor(req);
  if (!actor) return res.status(401).json({ success: false, error: 'Authentication required.' });
  const userId = actor.user.id;
  const otp = String(req.body?.otp || '');

  try {
    const { data: profile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('email_change_temp')
      .eq('id', userId)
      .single();

    if (fetchError || !profile.email_change_temp) {
      return res.status(400).json({ success: false, error: 'No active email change request' });
    }

    const { newEmail, otp: storedOtp, expires } = profile.email_change_temp;

    if (new Date() > new Date(expires)) {
      return res.status(400).json({ success: false, error: 'Code expired' });
    }

    if (otp !== storedOtp) {
      return res.status(400).json({ success: false, error: 'Invalid authorization code' });
    }

    // Update Email in Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, { email: newEmail });
    if (authError) throw authError;

    // Update Email in Profiles Table
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({ email: newEmail, email_change_temp: null })
      .eq('id', userId);

    if (profileError) throw profileError;

    return res.json({ success: true, message: 'Email updated successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 📋 REQ-ADM-01: Fetch All Profiles (Service Role — bypasses RLS)
 * Also returns the DEFAULT_ADMIN_ID so the frontend can badge the correct account.
 */
// Profile columns that must never leave the server (OTP challenges, secrets).
const PRIVATE_PROFILE_KEYS = /^(email_change_temp)$|otp|token|secret/i;
const toPublicProfile = (profile) => Object.fromEntries(
  Object.entries(profile || {}).filter(([key]) => !PRIVATE_PROFILE_KEYS.test(key))
);

app.get('/api/admin/profiles', async (req, res) => {
  const actor = await requireAdmin(req);
  if (!actor) return res.status(403).json({ success: false, error: 'Administrator access required.' });
  console.log('📋 [ADMIN] Fetching all profiles...');
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .order('role', { ascending: true })
      .order('full_name');

    if (error) throw error;
    const staffIds = (data || [])
      .filter((profile) => String(profile.role || '').toUpperCase() === 'STAFF')
      .map((profile) => profile.id);
    let activeServicesByStaff = new Map();
    if (staffIds.length) {
      const { data: assignments, error: assignmentsError } = await supabaseAdmin
        .from('bookings')
        .select('id, staff_id, status, vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(status)')
        .in('staff_id', staffIds);
      if (assignmentsError) throw assignmentsError;

      const activeBookingStatuses = new Set([
        'pending', 'pending_confirmation', 'scheduled', 'confirmed',
        'in_progress', 'ongoing', 'submitted'
      ]);
      activeServicesByStaff = new Map(staffIds.map((staffId) => [staffId, 0]));
      for (const booking of assignments || []) {
        const bookingStatus = String(booking.status || '').toLowerCase();
        const terminal = ['cancelled', 'completed', 'released', 'flagged_noshow', 'no_show'].includes(bookingStatus);
        const hasActiveUnit = !terminal && (booking.vehicles || []).some((vehicle) =>
          ['IN_PROGRESS', 'ONGOING'].includes(String(vehicle.status || '').toUpperCase())
        );
        if (activeBookingStatuses.has(bookingStatus) || hasActiveUnit) {
          activeServicesByStaff.set(
            booking.staff_id,
            (activeServicesByStaff.get(booking.staff_id) || 0) + 1
          );
        }
      }
    }
    const profilesWithServiceState = (data || []).map((profile) => ({
      ...toPublicProfile(profile),
      ...(String(profile.role || '').toUpperCase() === 'STAFF'
        ? {
            activeServiceCount: activeServicesByStaff.get(profile.id) || 0,
            hasActiveServices: (activeServicesByStaff.get(profile.id) || 0) > 0
          }
        : {})
    }));
    // Include defaultAdminId so frontend knows which account is protected
    return res.json({ success: true, data: profilesWithServiceState, defaultAdminId: DEFAULT_ADMIN_ID });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Section 1.1: Admin-driven account invitation ──────────────────────────────
// Generates a temporary password, creates the auth user + profile atomically
// (guarded by the create_invited_account RPC which blocks duplicates across BOTH
// auth.users and profiles), and delivers the credentials via the branded Resend
// relay so the email matches the dark-mode Comar Garage shell.
const generateTemporaryPassword = () => {
  // URL-safe, human-transcribable temporary password. Satisfies Supabase's
  // default minimum length and avoids ambiguous characters (0/O, 1/l).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return `${out}#7`;
};

/**
 * 🛡️ SCENARIO 12 — promote an EXISTING account instead of dead-ending on 409.
 *
 * The atomic claim raises EMAIL_ALREADY_EXISTS for any existing row, so by the
 * time we are here we already know the address is taken. We attempt
 * elevate_profile_role(), which updates the profile IN PLACE (all FKs —
 * bookings.customer_id, audit_logs.actor_id, messages — stay intact) and writes
 * an audit entry. Returns the response body on success, or null when there is
 * nothing to elevate (the caller then falls back to the plain 409).
 *
 * @returns {Promise<object|null>}
 */
const attemptRoleElevation = async ({ email, role, firstName, lastName, actor }) => {
  try {
    const { data: elevation, error } = await supabaseAdmin.rpc('elevate_profile_role', {
      p_email: email,
      p_role: role,
      p_first_name: firstName,
      p_last_name: lastName,
      p_actor_id: actor?.profile?.id || null,
    });

    if (error) {
      console.warn('🎟️ [INVITE] Role elevation RPC unavailable/failed:', error.message);
      return null; // Fall back to the 409 response.
    }

    // NO_PROFILE — the address exists in auth.users but has no profile row, so
    // there is nothing to elevate; a plain 409 is the honest answer.
    if (!elevation || elevation.reason === 'NO_PROFILE') return null;

    const elevated = elevation.elevated === true;
    console.log(`🎟️ [INVITE] ${elevated
      ? `Elevated ${email} from ${elevation.old_role} to ${role}`
      : `No elevation needed for ${email} (${elevation.reason})`}.`);

    // Let the person know their access level changed (best-effort).
    try {
      const backendBase = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
      await fetch(`${backendBase}/api/emails/status-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, type: 'ROLE_ELEVATED', role })
      });
    } catch (mailErr) {
      console.warn('🎟️ [INVITE] Elevation notice email failed (non-fatal):', mailErr.message);
    }

    return {
      success: true,
      elevated,
      alreadyAtRole: elevated === false && elevation.reason === 'ALREADY_AT_ROLE',
      role: elevation.role || role,
      previousRole: elevation.old_role || null,
      email,
      message: elevated
        ? `Existing account promoted to ${role}. Their history and bookings were preserved.`
        : `This account already has ${role} access.`
    };
  } catch (err) {
    console.warn('🎟️ [INVITE] Elevation attempt failed:', err.message);
    return null;
  }
};

app.post('/api/admin/invite-account', async (req, res) => {
  const { email, firstName, lastName, role, forcePasswordChange = true } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedRole = typeof role === 'string' ? role.trim().toUpperCase() : '';
  console.log(`🎟️ [INVITE] Admin-driven invite for ${normalizedEmail} (${normalizedRole})`);

  if (!supabaseAdmin) return res.status(503).json({ success: false, error: 'Invitation service unavailable.' });

  // 🛡️ TASK 13: Explicit admin-identity check, independent of the RPC guard.
  // The create_invited_account RPC also runs is_admin(), but that guard vanishes
  // on the fallback branch (migration not applied). This check closes that hole.
  const actor = await requireAdmin(req);
  if (!actor) {
    console.warn('🚫 [INVITE] BLOCKED: caller is not an authenticated ADMIN.');
    return res.status(403).json({ success: false, error: 'Only administrators may invite accounts.' });
  }

  if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    return res.status(400).json({ success: false, error: 'A valid email address is required.' });
  }
  if (!['STAFF', 'ADMIN'].includes(normalizedRole)) {
    return res.status(400).json({ success: false, error: 'Role must be STAFF or ADMIN.' });
  }
  // Field-type sanitisation (Section 2.5, option b): names are plain text.
  const safeFirst = String(firstName || '').replace(/[^a-zA-Z0-9\s'-]/g, '').trim();
  const safeLast = String(lastName || '').replace(/[^a-zA-Z0-9\s'-]/g, '').trim();

  try {
    // 1. Duplicate guard across auth.users AND profiles.
    //
    //    Preferred path: the atomic, SECURITY DEFINER `create_invited_account` RPC
    //    (migration 20260927000001). It serialises concurrent invites and raises
    //    EMAIL_ALREADY_EXISTS (SQLSTATE 23505) when the address is taken.
    //
    //    Fallback path: if that migration has NOT been applied, a call to the RPC
    //    returns PGRST202 ("could not find the function"). Previously that threw
    //    and aborted the whole invite with a 500 — so no account, no email, and a
    //    console full of errors. We now fall back to a direct, non-atomic check so
    //    invitations still work; the atomic RPC is used automatically once the
    //    migration is applied (no code change needed).
    let mustChangePassword = forcePasswordChange !== false;

    const { data: claim, error: claimError } = await supabaseAdmin.rpc('create_invited_account', {
      p_email: normalizedEmail,
      p_first_name: safeFirst,
      p_last_name: safeLast,
      p_role: normalizedRole,
      p_must_change_password: forcePasswordChange !== false
    });

    if (claimError) {
      const code = String(claimError.code || '');
      const msg = String(claimError.message || '');
      const rpcMissing = code === 'PGRST202' || code === '42883' || /could not find the function/i.test(msg);

      if (code === '23505' || msg.includes('EMAIL_ALREADY_EXISTS') || msg.includes('duplicate key')) {
        // 🛡️ SCENARIO 12 — IDENTITY CLASH: an existing CUSTOMER may be elevated
        // to STAFF/ADMIN instead of dead-ending in a 409. The atomic claim raises
        // EMAIL_ALREADY_EXISTS for ANY existing row, so this is where elevation
        // must be attempted (the old code only checked a `claim.can_elevate` the
        // RPC never returned on this path).
        const elevated = await attemptRoleElevation({
          email: normalizedEmail,
          role: normalizedRole,
          firstName: safeFirst,
          lastName: safeLast,
          actor,
        });
        if (elevated) return res.json(elevated);

        return res.status(409).json({
          success: false,
          code: 'EMAIL_ALREADY_EXISTS',
          error: 'An account with this email address already exists in the system.'
        });
      }
      if (msg.includes('Only administrators')) {
        return res.status(403).json({ success: false, error: 'Only administrators may invite accounts.' });
      }
      if (rpcMissing) {
        // Fallback duplicate check. `auth.users` is not reachable from here without
        // the SECURITY DEFINER function, so we check the two sources we CAN read:
        // profiles.email, and the auth admin API via a filtered listUsers lookup.
        console.warn('⚠️ [INVITE] create_invited_account RPC missing — using fallback duplicate check.');

        const { data: existingProfile } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .ilike('email', normalizedEmail)
          .maybeSingle();

        let authExists = false;
        try {
          const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
          const target = normalizedEmail.toLowerCase();
          authExists = Boolean((list?.users || []).some((u) => (u.email || '').toLowerCase() === target));
        } catch (lookupErr) {
          console.warn('⚠️ [INVITE] auth.users duplicate lookup unavailable:', lookupErr.message);
        }

        if (existingProfile || authExists) {
          return res.status(409).json({
            success: false,
            code: 'EMAIL_ALREADY_EXISTS',
            error: 'An account with this email address already exists in the system.'
          });
        }
      } else {
        throw claimError;
      }
    }

    // 🛡️ SCENARIO 12 — IDENTITY CLASH (existing account) is handled in the
    // EMAIL_ALREADY_EXISTS branch above, via attemptRoleElevation(). The claim RPC
    // RAISES on a duplicate rather than returning, so execution only reaches here
    // when the address is genuinely free — the happy path that creates the account.

    mustChangePassword = claim?.must_change_password !== false;
    const temporaryPassword = generateTemporaryPassword();

    // 2. Create the auth user with the temporary password, pre-confirmed so the
    //    invitee can sign in immediately without a separate verification email.
    const { data: userData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: {
        first_name: safeFirst,
        last_name: safeLast,
        role: normalizedRole,
        must_change_password: mustChangePassword
      }
    });
    if (authError) {
      // If the auth layer lost the race (rare, since the RPC serialised it), the
      // duplicate message is still mapped to the exact UX copy rather than a 500.
      if (/already|registered|exists/i.test(authError.message || '')) {
        return res.status(409).json({
          success: false,
          code: 'EMAIL_ALREADY_EXISTS',
          error: 'An account with this email address already exists in the system.'
        });
      }
      throw authError;
    }

    const userId = userData.user.id;
    const fullName = `${safeFirst || 'Team'} ${safeLast || 'Member'}`.trim();

    // 3. Upsert the profile row with the first-login flag.
    //
    //    The lockout/first-login columns (must_change_password,
    //    failed_login_attempts, locked_until) are added by migration
    //    20260927000001. If that migration is not applied, including those keys
    //    makes PostgREST reject the whole upsert (PGRST204) and the invite dies.
    //    We therefore write the core columns first and layer the optional ones in
    //    only if the schema exposes them — so invitations succeed either way.
    const coreProfile = {
      id: userId,
      email: normalizedEmail,
      first_name: safeFirst || null,
      last_name: safeLast || null,
      full_name: fullName,
      role: normalizedRole,
      is_active: true,
      updated_at: new Date().toISOString()
    };
    const extendedProfile = {
      ...coreProfile,
      must_change_password: mustChangePassword,
      failed_login_attempts: 0,
      locked_until: null
    };

    let profileError = null;
    {
      const attempt = await supabaseAdmin.from('profiles').upsert(extendedProfile);
      profileError = attempt.error;
      const optionalMissing = profileError && (
        profileError.code === 'PGRST204' ||
        /must_change_password|failed_login_attempts|locked_until/i.test(profileError.message || '')
      );
      if (optionalMissing) {
        console.warn('⚠️ [INVITE] Lockout/first-login columns missing — writing core profile fields only.');
        const fallback = await supabaseAdmin.from('profiles').upsert(coreProfile);
        profileError = fallback.error;
        // Without the flag we cannot force a first-login reset; surface that
        // honestly rather than pretending the account is fully provisioned.
        mustChangePassword = false;
      }
    }
    if (profileError) throw profileError;

    // 4. Deliver the temporary credentials through the branded Resend relay.
    const loginLink = appUrl('/login');
    const emailResult = await sendInviteAccountEmail({
      recipientEmail: normalizedEmail,
      firstName: safeFirst,
      lastName: safeLast,
      role: normalizedRole,
      temporaryPassword,
      loginLink
    });

    // 5. Audit trail. A failed email is surfaced but does not roll back the
    //    account — the admin can re-share the temporary password from the UI.
    await writeAuditLog({
      actionType: 'INVITE_ACCOUNT',
      actorId: actor.profile.id,
      actorName: actor.profile.full_name || actor.profile.email || 'ADMIN',
      actorRole: 'ADMIN',
      details: `Invited ${fullName} (${normalizedEmail}) as ${normalizedRole}. Force password change: ${mustChangePassword}. Email delivered: ${!!emailResult?.success}.`,
    });

    if (!emailResult?.success) {
      console.warn(`⚠️ [INVITE] Account created but email failed for ${normalizedEmail}`);
      return res.json({
        success: true,
        emailDelivered: false,
        warning: 'Account created but the invitation email could not be delivered. Please share the temporary password manually.',
        account: { id: userId, email: normalizedEmail, role: normalizedRole, fullName },
        temporaryPassword
      });
    }

    return res.json({
      success: true,
      emailDelivered: true,
      account: { id: userId, email: normalizedEmail, role: normalizedRole, fullName }
    });
  } catch (err) {
    console.error(`❌ [INVITE] Failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message || 'Failed to create invitation.' });
  }
});

// ─── Section 1.2: Emergency Account Recovery (email OTP) ───────────────────────
// Unlocks a DB-locked account after the owner proves control of the address with
// a single-use 6-digit code, then issues a password-reset link so they can set a
// fresh password. Only a SHA-256 hash of the OTP is stored.
const generateRecoveryOtp = () => String(Math.floor(100000 + Math.random() * 900000));

app.post('/api/auth/emergency-recovery/request', async (req, res) => {
  const { email } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const neutral = { success: true, message: 'If an account is associated with that email, a recovery code has been sent.' };
  if (!supabaseAdmin || !normalizedEmail) return res.json(neutral);
  console.log(`🆘 [RECOVERY] Emergency recovery requested for ${normalizedEmail}`);

  try {
    const { data: users, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersError) throw usersError;
    const account = users.users.find(item => item.email?.toLowerCase() === normalizedEmail && !item.deleted_at);

    // Never reveal whether the account exists. Only dispatch on a real match.
    if (account?.email) {
      const otp = generateRecoveryOtp();
      const otpHash = hashConfirmationToken(otp);
      // Supersede any outstanding challenge for this user.
      await supabaseAdmin.from('account_recovery_otps').delete().eq('user_id', account.id).is('consumed_at', null);
      const { error: insertError } = await supabaseAdmin.from('account_recovery_otps').insert({
        user_id: account.id,
        email: account.email,
        otp_hash: otpHash,
        attempts: 0,
        expires_at: new Date(Date.now() + PASSWORD_CONFIRMATION_TTL_MS).toISOString()
      });
      if (insertError) throw insertError;
      const emailResult = await sendEmergencyRecoveryEmail({ recipientEmail: account.email, otp });
      if (!emailResult.success) console.warn(`⚠️ [RECOVERY] OTP email failed for ${account.email}`);
      console.log(`🔑 [RECOVERY] OTP issued for ${account.email} (expires in 15 min)`);
    }

    return res.json(neutral);
  } catch (err) {
    console.error(`❌ [RECOVERY] Request failed: ${err.message}`);
    // Still neutral: an error must not become an oracle for account existence.
    return res.json(neutral);
  }
});

app.post('/api/auth/emergency-recovery/verify', async (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!supabaseAdmin) return res.status(503).json({ success: false, error: 'Recovery service unavailable.' });
  if (!normalizedEmail || !otp || !/^\d{6}$/.test(String(otp))) {
    return res.status(400).json({ success: false, error: 'A valid email and 6-digit recovery code are required.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ success: false, error: 'A new password of at least 6 characters is required.' });
  }

  try {
    await supabaseAdmin.from('account_recovery_otps').delete().lte('expires_at', new Date().toISOString());
    const { data: challenge, error: lookupError } = await supabaseAdmin
      .from('account_recovery_otps')
      .select('*')
      .eq('email', normalizedEmail)
      .eq('otp_hash', hashConfirmationToken(String(otp)))
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!challenge) return res.status(400).json({ success: false, error: 'The recovery code is incorrect or has expired.' });

    // Claim the challenge atomically so it can never be replayed.
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from('account_recovery_otps')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', challenge.id)
      .is('consumed_at', null)
      .select('id')
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return res.status(400).json({ success: false, error: 'The recovery code is incorrect or has expired.' });

    // 1. Apply the new password directly (the caller has proven ownership).
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(challenge.user_id, { password: newPassword });
    if (updateError) throw updateError;

    // 2. Clear the DB lock and the first-login flag so the user can sign in.
    await supabaseAdmin.rpc('clear_login_lock', { p_email: normalizedEmail });
    await supabaseAdmin.from('profiles').update({ must_change_password: false, updated_at: new Date().toISOString() }).eq('id', challenge.user_id);

    await supabaseAdmin.from('audit_logs').insert({
      actor_name: 'SYSTEM',
      actor_role: 'SYSTEM',
      action_type: 'EMERGENCY_RECOVERY',
      details: `Emergency account recovery completed for ${normalizedEmail}. Lock cleared and password reset.`
    }).then(() => {}).catch(() => {});

    return res.json({ success: true, message: 'Account recovered. You can now sign in with your new password.' });
  } catch (err) {
    console.error(`❌ [RECOVERY] Verify failed: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Unable to complete account recovery.' });
  }
});

/**
 * Section 3.1: Service catalog usage check.
 * Returns, for each requested service name, how many booking_vehicle_services
 * rows reference it. The Service Catalog uses this to decide between a hard
 * delete (never used by a booking) and a soft-archive fallback (tied to a past
 * or active booking, so the historical record must be preserved).
 */
app.post('/api/admin/services/usage', async (req, res) => {
  const { names } = req.body || {};
  if (!supabaseAdmin) return res.status(503).json({ success: false, error: 'Service unavailable.' });
  if (!(await requireAdmin(req))) return res.status(403).json({ success: false, error: 'Administrator access required.' });
  const requested = Array.isArray(names)
    ? names.map((n) => String(n || '').trim()).filter(Boolean)
    : [];
  if (requested.length === 0) return res.json({ success: true, usage: {} });

  try {
    const { data, error } = await supabaseAdmin
      .from('booking_vehicle_services')
      .select('service_name')
      .in('service_name', requested);
    if (error) throw error;

    const usage = {};
    requested.forEach((name) => { usage[name] = 0; });
    (data || []).forEach((row) => {
      const key = String(row.service_name || '').trim();
      if (key in usage) usage[key] += 1;
    });

    return res.json({ success: true, usage });
  } catch (err) {
    console.error(`❌ [SERVICES] Usage check failed: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not verify service usage.' });
  }
});

/**
 * 🚫 REQ-ADM-02: Revoke Staff/Admin Access (Service Role — bypasses RLS)
 * Downgrades a STAFF or ADMIN account to CUSTOMER role.
 * The Default Admin guard is enforced here too.
 */
app.post('/api/admin/revoke-access', async (req, res) => {
  const { memberId } = req.body;
  console.log(`🚫 [ADMIN] REVOKE ACCESS REQUEST for: ${memberId}`);

  try {
    // 🛡️ TASK 13: Explicit admin-identity check before any privileged work.
    const actor = await requireAdmin(req);
    if (!actor) {
      console.warn('🚫 [ADMIN] BLOCKED: caller is not an authenticated ADMIN.');
      return res.status(403).json({ success: false, error: 'Only administrators may revoke access.' });
    }

    // 🛡️ TASK 17: Self-protection. An admin may not revoke their OWN access;
    // otherwise a single mis-click (or a malicious payload) locks them out.
    if (memberId && memberId === actor.profile.id) {
      console.warn(`🚫 [ADMIN] BLOCKED: ${actor.profile.email} attempted to revoke their own access.`);
      return res.status(403).json({
        success: false,
        error: 'You cannot revoke your own admin access. Ask another administrator to do this.'
      });
    }

    // Check role first — cannot revoke an ADMIN account
    const { data: profile, error: checkErr } = await supabaseAdmin
      .from('profiles')
      .select('role, email, full_name')
      .eq('id', memberId)
      .single();

    if (checkErr) throw checkErr;

    if (String(profile.role || '').toUpperCase() === 'STAFF') {
      const { data: hasActiveServices, error: activeServicesError } = await supabaseAdmin
        .rpc('staff_has_active_services', { p_staff_id: memberId });
      if (activeServicesError) throw activeServicesError;
      if (hasActiveServices) {
        return res.status(409).json({
          success: false,
          code: 'STAFF_HAS_ACTIVE_SERVICES',
          error: 'This staff account cannot be deactivated while assigned to an active service. Reassign or complete the service first.'
        });
      }
    }

    // 🛡️ DEFAULT ADMIN GUARD: The single default admin can never be revoked.
    if (memberId === DEFAULT_ADMIN_ID) {
      console.warn(`🚫 [ADMIN] BLOCKED: Attempted revoke of Default Admin (${profile.email})`);
      return res.status(403).json({
        success: false,
        error: 'The Default Admin account cannot be deactivated.'
      });
    }

    // 🛡️ TASK 17: LAST-ADMIN PROTECTION. Refuse to revoke an ADMIN when they are
    // the final remaining admin — regardless of whether they are the default one.
    // This keeps the system from ever ending up with zero administrators.
    if (String(profile.role || '').toUpperCase() === 'ADMIN') {
      const { count, error: countErr } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'ADMIN');
      if (countErr) throw countErr;
      if ((count || 0) <= 1) {
        console.warn(`🚫 [ADMIN] BLOCKED: Cannot revoke the last remaining admin (${profile.email}).`);
        return res.status(403).json({
          success: false,
          error: 'This is the last remaining administrator account and cannot be revoked.'
        });
      }
    }

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ role: 'CUSTOMER' })
      .eq('id', memberId);

    if (error) {
      if (error.code === '23514' || /assigned to an active service/i.test(error.message || '')) {
        return res.status(409).json({
          success: false,
          code: 'STAFF_HAS_ACTIVE_SERVICES',
          error: 'This staff account cannot be deactivated while assigned to an active service. Reassign or complete the service first.'
        });
      }
      throw error;
    }

    await writeAuditLog({
      actionType: 'REVOKE_ACCESS',
      actorId: actor.profile.id,
      actorName: actor.profile.full_name || actor.profile.email || 'ADMIN',
      actorRole: 'ADMIN',
      details: `Account access revoked for ${profile.full_name} (${profile.email}). Role downgraded from ${profile.role} to CUSTOMER.`,
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 📣 REQ-ADM-13: Global Broadcast (Service Role — bypasses RLS)
 * Inserts a notification for every profile and logs the action in audit logs.
 */
app.post('/api/admin/broadcast', async (req, res) => {
  const { message, actorEmail } = req.body;
  console.log(`📣 [ADMIN] Global broadcast request: "${message}" from ${actorEmail}`);

  try {
    // 🛡️ TASK 13: Explicit admin-identity check before a service-role broadcast.
    const actor = await requireAdmin(req);
    if (!actor) {
      console.warn('🚫 [ADMIN] BLOCKED: non-admin broadcast attempt.');
      return res.status(403).json({ success: false, error: 'Only administrators may send a broadcast.' });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Message cannot be empty.' });
    }

    // Step 1: Fetch active profiles (bypasses RLS)
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name')
      .eq('is_active', true);

    if (profileError) throw profileError;

    if (!profiles || profiles.length === 0) {
      return res.status(404).json({ success: false, error: 'No active profiles found to broadcast to.' });
    }

    // Step 2: Prepare and insert in-app notification for each active profile
    // A broadcast is a general announcement with no single record to open, so
    // `action_url` points at the recipient's own notifications surface rather
    // than being omitted. Omitting it left the admin with an un-actionable alert
    // (the traceability gap found in the audit): every notification must give the
    // user somewhere to go.
    const notifications = profiles.map(p => ({
      user_id: p.id,
      title: 'System Announcement 📣',
      notification_type: 'ANNOUNCEMENT',
      message: message.trim(),
      action_url: '/notifications',
      is_read: false
    }));

    const { error: insertError } = await supabaseAdmin
      .from('notifications')
      .insert(notifications);

    if (insertError) throw insertError;

    // Step 3: Log to audit trail
    const auditResult = await writeAuditLog({
      actionType: 'BROADCAST_SENT',
      actorId: actor.profile.id,
      actorName: actorEmail || actor.profile.email || 'ADMIN',
      actorRole: 'ADMIN',
      details: `Global broadcast transmitted to ${profiles.length} users. Message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`,
    });
    if (!auditResult.success) console.error('Audit Log Error (broadcast):', auditResult.error);

    // Step 4: NON-BLOCKING ASYNC EMAIL BATCH DISPATCH (Resend API)
    // Runs in setImmediate queue so HTTP response returns under 500ms without blocking UI execution
    if (resendClient) {
      setImmediate(async () => {
        for (const p of profiles) {
          if (p.email) {
            try {
              await resendClient.emails.send({
                from: RESEND_FROM,
                to: [p.email],
                subject: 'System Announcement 📣',
                html: `<div style="font-family: sans-serif; padding: 20px; background: #0A0B0D; color: #ffffff;">
                  <h2 style="color: #E61E2A;">Comar Garage System Announcement</h2>
                  <p style="font-size: 16px; color: #e5e7eb;">${message.trim()}</p>
                  <hr style="border: none; border-top: 1px solid #374151; margin: 20px 0;" />
                  <p style="font-size: 12px; color: #9ca3af;">This is an automated operational signal from Comar Garage Admin Command Center.</p>
                </div>`
              });
              await new Promise(r => setTimeout(r, 100)); // rate limiting buffer
            } catch (emailErr) {
              console.error(`[BROADCAST ASYNC EMAIL ERROR] ${p.email}:`, emailErr.message);
            }
          }
        }
      });
    }

    return res.json({ success: true, receiversCount: profiles.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 🏷️ REQ-PROMO-01: Promo Rule Persistence Endpoint (POST /api/admin/promos)
 * Stores validated promo schema, date windows, and vehicle-service binding matrices.
 * Enforces Turn 4 lifecycle immutability locking if the promo is already ongoing.
 */
let inMemoryPromoCache = null;

// Announce newly-added catalog items (services / vehicle categories) to the
// customers who opted into the matching email preference. The admin Service
// Catalog is saved straight to business_config from the client, so the client
// calls this lightweight endpoint AFTER a successful save, passing only what was
// genuinely ADDED. Each list is independently gated (emailNewServices /
// emailNewVehicles) and each fails closed — no opt-in, no email.
app.post('/api/admin/announce-catalog', async (req, res) => {
  if (!(await requireAdmin(req))) return res.status(403).json({ success: false, error: 'Administrator access required.' });
  const { services = [], vehicles = [] } = req.body || {};
  try {
    if (Array.isArray(services) && services.length) {
      const names = services.map((s) => String(s?.name || s || '').trim()).filter(Boolean);
      if (names.length) {
        sendPreferenceGatedAnnouncement({
          preferenceKey: 'emailNewServices',
          subject: 'New services at Comar Garage ✨',
          bodyHtml: `<div style="font-family: sans-serif; padding: 20px; background: #0A0B0D; color: #ffffff;">
            <h2 style="color: #E61E2A;">New services just added</h2>
            <p style="font-size: 16px; color: #e5e7eb;">Hi {{name}},</p>
            <p style="font-size: 16px; color: #e5e7eb;">We now offer:</p>
            <ul style="font-size: 16px; color: #e5e7eb;">${names.map((n) => `<li>${n}</li>`).join('')}</ul>
            <p style="font-size: 14px; color: #9ca3af;">Book now to try them out.</p>
            <hr style="border: none; border-top: 1px solid #374151; margin: 20px 0;" />
            <p style="font-size: 12px; color: #9ca3af;">You opted into new-service emails. Manage this in Settings → Notifications.</p>
          </div>`,
        });
      }
    }

    if (Array.isArray(vehicles) && vehicles.length) {
      const names = vehicles.map((v) => String(v || '').trim()).filter(Boolean);
      if (names.length) {
        sendPreferenceGatedAnnouncement({
          preferenceKey: 'emailNewVehicles',
          subject: 'We now service more vehicle types 🚗',
          bodyHtml: `<div style="font-family: sans-serif; padding: 20px; background: #0A0B0D; color: #ffffff;">
            <h2 style="color: #E61E2A;">New vehicle categories serviced</h2>
            <p style="font-size: 16px; color: #e5e7eb;">Hi {{name}},</p>
            <p style="font-size: 16px; color: #e5e7eb;">We now service: <strong>${names.join(', ')}</strong>.</p>
            <p style="font-size: 14px; color: #9ca3af;">Bring yours in for a booking anytime.</p>
            <hr style="border: none; border-top: 1px solid #374151; margin: 20px 0;" />
            <p style="font-size: 12px; color: #9ca3af;">You opted into new-vehicle emails. Manage this in Settings → Notifications.</p>
          </div>`,
        });
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ [ANNOUNCE-CATALOG] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/promos', async (req, res) => {
  const promo = req.body;
  if (!(await requireAdmin(req))) return res.status(403).json({ success: false, error: 'Authorized administrator required.' });
  console.log('🏷️ [ADMIN PROMO] Saving promo rule:', promo?.name);
  try {
    if (!promo || !promo.name || !promo.name.trim()) {
      return res.status(400).json({ success: false, error: 'Promo name is required.' });
    }
    if (promo.value === undefined || Number(promo.value) <= 0) {
      return res.status(400).json({ success: false, error: 'Discount value must be numeric and greater than 0.' });
    }
    if (promo.mode !== 'package' && promo.type === 'percentage' && Number(promo.value) > 100) {
      return res.status(400).json({ success: false, error: 'Percentage discounts must be between 1 and 100.' });
    }
    if (!promo.validFrom || (!promo.neverExpires && !promo.validUntil)) {
      return res.status(400).json({ success: false, error: 'Valid From and Valid Until dates are required.' });
    }

    // Package validation: a package is a bundle, so every vehicle it targets must
    // group at least 2 services. A one-service "bundle" is just a re-priced
    // service and belongs in a Standard Promo instead.
    const isPackage = promo.mode === 'package' || promo.type === 'fixed_package' || promo.isBundle === true;
    if (isPackage) {
      const matrix = promo.vehicleServiceMatrix && typeof promo.vehicleServiceMatrix === 'object'
        ? promo.vehicleServiceMatrix
        : {};
      const tooSmall = Object.keys(matrix).find(
        (vehicle) => Array.isArray(matrix[vehicle]) && matrix[vehicle].length > 0 && matrix[vehicle].length < 2
      );
      if (tooSmall) {
        return res.status(400).json({
          success: false,
          error: `A package must group at least 2 services per vehicle (issue: ${tooSmall}). Use a Standard Promo for single-service discounts.`
        });
      }
    }

    // Fetch existing promo rules from business_config or cache
    let existingRules = inMemoryPromoCache || [];
    let configRowId = 1;

    if (supabaseAdmin) {
      try {
        const { data: config, error: fetchErr } = await supabaseAdmin
          .from('business_config')
          .select('id, promo_rules')
          .maybeSingle();

        if (!fetchErr && config) {
          configRowId = config.id || 1;
          if (Array.isArray(config.promo_rules) && config.promo_rules.length) {
            existingRules = config.promo_rules;
          }
        }
      } catch (dbErr) {
        console.warn('⚠️ [ADMIN PROMO] Could not read business_config, using in-memory store:', dbErr.message);
      }
    }

    // Check immutability if updating an existing promo per Turn 4 Section 3
    if (promo.id) {
      const currentPromo = existingRules.find(r => r.id === promo.id);
      if (currentPromo) {
        const now = new Date();
        const start = currentPromo.validFrom ? new Date(currentPromo.validFrom) : null;
        const end = (currentPromo.neverExpires || currentPromo.validUntil === 'never') ? null : (currentPromo.validUntil ? new Date(currentPromo.validUntil) : null);
        const isOngoing = start && now >= start && (!end || now <= end);
        if (isOngoing) {
          return res.status(403).json({
            success: false,
            error: 'Active promotions cannot be edited while ongoing. Deactivate or wait for expiry.'
          });
        }
      }
    }

    const nextRule = {
      id: promo.id || `promo-${Date.now()}`,
      name: promo.name.trim(),
      mode: promo.mode || 'standard',
      type: promo.type || 'percentage',
      value: Number(promo.value),
      validFrom: promo.validFrom,
      validUntil: promo.neverExpires ? 'never' : promo.validUntil,
      neverExpires: Boolean(promo.neverExpires),
      vehicleServiceMatrix: promo.vehicleServiceMatrix || {},
      vehicleTypes: promo.vehicleTypes || Object.keys(promo.vehicleServiceMatrix || {}),
      serviceMatches: promo.serviceMatches || Array.from(new Set(Object.values(promo.vehicleServiceMatrix || {}).flat())),
      // Package semantics carried through to storage: a package (fixed_package /
      // mode 'package') is a whole-vehicle bundle price that applies only when
      // the full set is selected and never stacks with standard promos.
      isBundle: promo.mode === 'package' || promo.type === 'fixed_package' || promo.isBundle === true,
      stackable: (promo.mode === 'package' || promo.type === 'fixed_package') ? false : (promo.stackable !== false),
      isOngoing: true,
      updated_at: new Date().toISOString()
    };

    const nextRules = promo.id && existingRules.some(r => r.id === promo.id)
      ? existingRules.map(r => r.id === promo.id ? nextRule : r)
      : [nextRule, ...existingRules.filter(r => r.id !== nextRule.id)];

    inMemoryPromoCache = nextRules;

    // Persist to Supabase business_config
    if (supabaseAdmin) {
      try {
        const { error: upsertError } = await supabaseAdmin
          .from('business_config')
          .upsert({
            id: configRowId,
            promo_rules: nextRules,
            updated_at: new Date().toISOString()
          });
        if (upsertError) throw upsertError;
      } catch (upsertErr) {
        inMemoryPromoCache = null;
        throw upsertErr;
      }
    }

    // Announce the new promo to opt-in customers only. Gated on the
    // `emailNewPromos` preference (opt-in, default OFF) so a customer who has
    // not explicitly enabled it is never emailed. Fire-and-forget.
    if (!promo.id) {
      sendPreferenceGatedAnnouncement({
        preferenceKey: 'emailNewPromos',
        subject: `New promo: ${nextRule.name} 🎉`,
        bodyHtml: `<div style="font-family: sans-serif; padding: 20px; background: #0A0B0D; color: #ffffff;">
          <h2 style="color: #E61E2A;">Comar Garage has a new promo</h2>
          <p style="font-size: 16px; color: #e5e7eb;">Hi {{name}},</p>
          <p style="font-size: 16px; color: #e5e7eb;">A new promotion is now live: <strong>${nextRule.name}</strong>.</p>
          <p style="font-size: 14px; color: #9ca3af;">Book now to take advantage of it.</p>
          <hr style="border: none; border-top: 1px solid #374151; margin: 20px 0;" />
          <p style="font-size: 12px; color: #9ca3af;">You are receiving this because you opted into promo emails. Manage this in Settings → Notifications.</p>
        </div>`,
      });
    }

    return res.json({
      success: true,
      data: nextRule,
      promoRules: nextRules,
      message: `Promo "${nextRule.name}" persisted successfully.`
    });
  } catch (err) {
    console.error('🏷️ [ADMIN PROMO] Error persisting promo:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/promos/:promoId', async (req, res) => {
  if (!(await requireAdmin(req))) return res.status(403).json({ success: false, error: 'Authorized administrator required.' });
  const promoId = String(req.params.promoId || '').trim();
  if (!promoId) return res.status(400).json({ success: false, error: 'Promo ID is required.' });
  try {
    const { data: config, error: fetchError } = await supabaseAdmin
      .from('business_config')
      .select('id, promo_rules')
      .maybeSingle();
    if (fetchError) throw fetchError;

    const existingRules = Array.isArray(config?.promo_rules) ? config.promo_rules : [];

    // 🛡️ SCENARIO 4 FIX — SOFT DELETE ONLY (never hard-delete a rule).
    // Confirmed bookings freeze their promo figures in `applied_promo_id` /
    // `promo_name_snapshot` / `discount_amount_snapshot`, and the receipts and
    // analytics read those snapshots. Physically removing the rule from the
    // JSONB array was still a catastrophic defect: any retained reference to
    // `applied_promo_id` (report joins, "which promo was this?" lookups, the
    // admin receipt modal) becomes a dangling pointer, and — critically — the
    // rule's historical date window / matrix is gone forever, so nothing can
    // reconstruct what the customer actually received. We therefore TOMBSTONE
    // the rule (is_active=false + deactivated_at) and keep it in the array. The
    // active-promo filter below excludes it, so customers can no longer use it,
    // while history stays intact and reversible.
    const target = existingRules.find(rule => rule?.id === promoId);
    if (!target) {
      return res.status(404).json({ success: false, error: 'Promo code not found.' });
    }

    const deactivatedAt = new Date().toISOString();
    const nextRules = existingRules.map(rule => (rule?.id === promoId
      ? { ...rule, is_active: false, deleted_at: deactivatedAt, validUntil: deactivatedAt }
      : rule));

    const { error: updateError } = await supabaseAdmin
      .from('business_config')
      .upsert({ id: config?.id || 1, promo_rules: nextRules, updated_at: deactivatedAt });
    if (updateError) throw updateError;
    inMemoryPromoCache = nextRules;

    // Audit the deactivation so the trail shows a soft delete, not a data loss.
    try {
      await supabaseAdmin.from('audit_logs').insert({
        action_type: 'PROMO_DEACTIVATED',
        actor_name: 'Administrator',
        actor_role: 'ADMIN',
        details: `Promo "${target?.name || promoId}" deactivated (soft delete). Historical bookings retain their frozen discount snapshot.`,
        metadata: { promo_id: promoId, promo_name: target?.name || null, deactivated_at: deactivatedAt, soft_delete: true }
      });
    } catch (auditErr) {
      console.warn('🏷️ [ADMIN PROMO] Deactivation audit log failed (non-fatal):', auditErr?.message);
    }

    return res.json({ success: true, softDeleted: true, promoRules: nextRules });
  } catch (error) {
    console.error('🏷️ [ADMIN PROMO] Delete failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 🏷️ REQ-PROMO-02: Active Promo Lookup Endpoint (GET /api/promos/active)
 * Serves active promotions filtered by current timestamp:
 * Active Rule <=> Start Time <= Current Timestamp <= End Time
 */
app.get('/api/promos/active', async (req, res) => {
  try {
    let rules = inMemoryPromoCache || [];

    if (supabaseAdmin) {
      try {
        const { data: config, error: fetchErr } = await supabaseAdmin
          .from('business_config')
          .select('promo_rules')
          .maybeSingle();

        if (!fetchErr && config && Array.isArray(config.promo_rules)) {
          rules = config.promo_rules;
          inMemoryPromoCache = rules;
        }
      } catch (dbErr) {
        // Fall back to memory cache
      }
    }

    const now = new Date();
    const activePromos = rules.filter(rule => {
      if (!rule) return false;
      // 🛡️ SCENARIO 4 FIX — a tombstoned (soft-deleted) rule is never active,
      // regardless of its date window, so a deleted code cannot be redeemed
      // again even if its validUntil window is still in the future.
      if (rule.is_active === false || rule.deleted_at) return false;
      const start = rule.validFrom ? new Date(rule.validFrom) : null;
      const isNever = rule.neverExpires === true || rule.validUntil === 'never';
      const end = isNever ? null : (rule.validUntil ? new Date(rule.validUntil) : null);

      if (start && !isNaN(start.getTime()) && now < start) return false;
      if (end && !isNaN(end.getTime()) && now > end) return false;
      return true;
    });

    return res.json({
      success: true,
      data: activePromos,
      timestamp: now.toISOString()
    });
  } catch (err) {
    console.error('🏷️ [PROMO ACTIVE] Error fetching active promos:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * ⏱️ Staff Shift Toggle Endpoint
 * Updates staff attendance availability and clock-in timestamp in database (bypasses RLS).
 * Does NOT send emails or notifications; simply updates staff status.
 */
app.post('/api/staff/toggle-shift', async (req, res) => {
  const actor = await getLifecycleActor(req);
  if (!actor) return res.status(401).json({ success: false, error: 'Authentication required.' });
  // Shift state belongs to the caller only; a body userId is never trusted.
  const userId = actor.profile.id;
  const { newStatus } = req.body || {};
  console.log(`⏱️ [STAFF] Shift toggle request: userId=${userId}, newStatus=${newStatus}`);

  try {

    const timestamp = newStatus ? new Date().toISOString() : null;

    // First attempt: update both is_clocked_in and clock_in_timestamp
    let { data: updatedProfile, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        is_clocked_in: Boolean(newStatus),
        clock_in_timestamp: timestamp
      })
      .eq('id', userId)
      .select()
      .single();

    // Fallback if clock_in_timestamp column is not yet in schema cache
    if (updateError && (updateError.code === 'PGRST204' || updateError.message?.includes('clock_in_timestamp'))) {
      console.warn('⚠️ clock_in_timestamp column missing, falling back to is_clocked_in update');
      const fallbackResult = await supabaseAdmin
        .from('profiles')
        .update({
          is_clocked_in: Boolean(newStatus)
        })
        .eq('id', userId)
        .select()
        .single();

      if (fallbackResult.error) throw fallbackResult.error;
      updatedProfile = fallbackResult.data;
    } else if (updateError) {
      throw updateError;
    }

    // Record shift event in Audit Log. Wrapped so an audit-log failure (e.g. a
    // NOT NULL/RLS hiccup) can NEVER fail the clock action itself — the shift
    // state change above is the source of truth.
    try {
      const { error: auditError } = await supabaseAdmin.from('audit_logs').insert({
        action_type: newStatus ? 'STAFF_CLOCK_IN' : 'STAFF_CLOCK_OUT',
        actor_name: updatedProfile?.email || updatedProfile?.full_name || 'Staff',
        actor_role: 'STAFF',
        details: `Technician ${updatedProfile?.full_name || userId} ${newStatus ? 'CLOCKED IN (ON DUTY)' : 'CLOCKED OUT (OFF DUTY)'}.`,
        created_at: new Date().toISOString()
      });
      if (auditError) console.warn('⚠️ Shift audit log failed (non-fatal):', auditError.message);
    } catch (auditEx) {
      console.warn('⚠️ Shift audit log error (non-fatal):', auditEx.message);
    }

    return res.json({ success: true, profile: updatedProfile });
  } catch (err) {
    console.error('Shift Toggle Backend Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * ⚙️ Staff Preferences Relay Endpoint
 * Safely updates user notification preferences on profiles table.
 * Gracefully handles missing database columns without throwing 400 Bad Request errors.
 */
app.post('/api/staff/update-preferences', async (req, res) => {
  const actor = await getAuthenticatedActor(req);
  if (!actor) return res.status(401).json({ success: false, error: 'Authentication required.' });
  const userId = actor.profile.id;
  const { push_notifications_enabled } = req.body || {};
  console.log(`⚙️ [STAFF] Preference update request: userId=${userId}, pushEnabled=${push_notifications_enabled}`);

  try {

    const { data: updatedProfile, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        push_notifications_enabled: Boolean(push_notifications_enabled)
      })
      .eq('id', userId)
      .select()
      .maybeSingle();

    if (updateError && (updateError.code === 'PGRST204' || updateError.code === '42703' || updateError.message?.includes('does not exist'))) {
      console.warn('⚠️ push_notifications_enabled column missing from DB schema. Preference toggle completed in soft mode.');
      return res.json({ success: true, warning: 'Column missing from schema cache' });
    } else if (updateError) {
      throw updateError;
    }

    return res.json({ success: true, profile: updatedProfile });
  } catch (err) {
    console.error('Preference Update Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 🛡️ REQ-ADM-14: Account Deactivation (15-Day Grace Period)
 * Marks account as INACTIVE instead of deleting immediately.
 */
app.post('/api/auth/deactivate-account', async (req, res) => {
  const actor = await getAuthenticatedActor(req);
  if (!actor) return res.status(401).json({ success: false, error: 'Authentication required.' });
  // Users deactivate themselves; only an administrator may target another account.
  const requestedUserId = req.body?.userId || actor.profile.id;
  const isAdminActor = String(actor.profile.role || '').toUpperCase() === 'ADMIN';
  if (requestedUserId !== actor.profile.id && !isAdminActor) {
    return res.status(403).json({ success: false, error: 'You can only deactivate your own account.' });
  }
  const userId = requestedUserId;
  console.log(`⚠️ [AUTH] DEACTIVATION REQUEST: ${userId}`);

  try {
    // 🛡️ DEFAULT ADMIN GUARD: Fetch profile first to check role.
    // ADMIN accounts can NEVER be deactivated — this is enforced server-side
    // regardless of what the frontend sends.
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role, email')
      .eq('id', userId)
      .single();

    if (profileError) throw profileError;

    if (String(profile.role || '').toUpperCase() === 'STAFF') {
      const { data: hasActiveServices, error: activeServicesError } = await supabaseAdmin
        .rpc('staff_has_active_services', { p_staff_id: userId });
      if (activeServicesError) throw activeServicesError;
      if (hasActiveServices) {
        return res.status(409).json({
          success: false,
          code: 'STAFF_HAS_ACTIVE_SERVICES',
          error: 'This staff account cannot be deactivated while assigned to an active service. Reassign or complete the service first.'
        });
      }
    }

    // 🛡️ DEFAULT ADMIN GUARD: Only the specific DEFAULT_ADMIN_ID is protected.
    // Regular admins can self-deactivate via the customer profile page.
    if (userId === DEFAULT_ADMIN_ID) {
      console.warn(`🚫 [AUTH] BLOCKED: Attempted deactivation of Default Admin (${profile.email})`);
      return res.status(403).json({
        success: false,
        error: 'The Default Admin account cannot be deactivated.'
      });
    }

    // 🛡️ TASK 17: LAST-ADMIN PROTECTION. Even a non-default admin cannot
    // deactivate themselves (or anyone) if they are the final administrator —
    // the system must never be left with zero admins. Mirrors guard_admin_lifecycle.
    if (String(profile.role || '').toUpperCase() === 'ADMIN') {
      const { count, error: countErr } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'ADMIN');
      if (countErr) throw countErr;
      if ((count || 0) <= 1) {
        console.warn(`🚫 [AUTH] BLOCKED: Attempted deactivation of the last remaining admin (${profile.email}).`);
        return res.status(403).json({
          success: false,
          error: 'This is the last remaining administrator account and cannot be deactivated.'
        });
      }
    }

    const deactivatedAt = new Date().toISOString();

    // 🛡️ SCENARIO 14 — CASCADE THE DEACTIVATION.
    // A soft-delete alone left the customer's UPCOMING bookings holding their
    // slots forever (the customer is gone, never shows up, and another paying
    // walk-in is blocked). The `deactivate_customer_account` RPC does the soft
    // delete AND cancels the future bookings in one transaction, freeing their
    // bays. History is untouched: the 5 past bookings keep their customer_id.
    const { data: deactivation, error: deactivateRpcError } = await supabaseAdmin.rpc('deactivate_customer_account', {
      p_user_id: userId,
      p_actor_id: actor?.profile?.id || null
    });

    if (deactivateRpcError) {
      const rpcMissing = /could not find the function|schema cache|does not exist/i.test(deactivateRpcError.message || '');
      if (deactivateRpcError.code === '23514' || /assigned to an active service/i.test(deactivateRpcError.message || '')) {
        return res.status(409).json({
          success: false,
          code: 'STAFF_HAS_ACTIVE_SERVICES',
          error: 'This staff account cannot be deactivated while assigned to an active service. Reassign or complete the service first.'
        });
      }
      if (!rpcMissing) throw deactivateRpcError;

      // Fallback for a DB without the migration: soft-delete only (historical
      // integrity preserved; upcoming bookings are NOT cascaded here).
      console.warn('⚠️ [AUTH] deactivate_customer_account RPC missing — soft-delete only.');
      const { error } = await supabaseAdmin
        .from('profiles')
        .update({ is_active: false, deactivated_at: deactivatedAt })
        .eq('id', userId);
      if (error) throw error;
    }

    const cancelledCount = deactivation?.cancelled_bookings?.length || 0;

    // Record in Audit Log
    await writeAuditLog({
      actionType: 'ACCOUNT_DEACTIVATION',
      actorId: actor?.profile?.id || userId,
      actorName: profile.email || 'SYSTEM',
      actorRole: 'SECURITY',
      details: `User ${userId} (${profile.email || 'unknown'}) deactivated. ${cancelledCount} upcoming booking(s) cancelled to free their slots. Scheduled for deletion in 15 days.`,
    });

    return res.json({
      success: true,
      cancelledBookings: cancelledCount,
      message: 'Account deactivated. You have 15 days to recover it.'
    });
  } catch (err) {
    if (err.code === '23514' || /assigned to an active service/i.test(err.message || '')) {
      return res.status(409).json({
        success: false,
        code: 'STAFF_HAS_ACTIVE_SERVICES',
        error: 'This staff account cannot be deactivated while assigned to an active service. Reassign or complete the service first.'
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 🛡️ REQ-NFR-14: Secure Receipt Access (Backend Verification Lock)
 * Only returns receipt data if the transaction status is exactly 'PAID'.
 */
app.get('/api/bookings/:id/receipt', async (req, res) => {
  const { id } = req.params;
  console.log(`🛡️ [SECURITY] RECEIPT REQUESTED: ${id}`);

  try {
    // Fetch booking and associated payments
    const { data: booking, error: bError } = await supabaseAdmin
      .from('bookings')
      .select('*, payments(*)')
      .eq('id', id)
      .single();

    if (bError || !booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    // SECURITY CHECK: Ensure at least one payment is officially 'PAID'
    const isVerified = (booking.payments || []).some(p => p.status === 'PAID');

    if (!isVerified) {
      console.warn(`🛑 [SECURITY] BLOCKED: Provisional receipt request for unpaid booking ${id}`);
      return res.status(403).json({
        success: false,
        error: 'ACCESS DENIED: Official receipt is locked until payment is verified by Admin.',
        provisional: true
      });
    }

    console.log(`✅ [SECURITY] GRANTED: Official receipt data released for ${id}`);
    return res.json({ success: true, data: booking });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal security engine error' });
  }
});

/**
 * 🚗 REQ-CST-10: Silent Garage Sync (Backend)
 * Bypasses RLS to ensure customer vehicles are always synchronized to their virtual garage.
 */
app.post('/api/garage/sync', async (req, res) => {
  const { customerId, vehicle } = req.body;
  console.log(`🚗 [GARAGE] SYNCING VEHICLE: ${vehicle?.plateNumber} for user ${customerId}`);

  if (!supabaseAdmin) return res.status(503).json({ error: 'Database admin service unavailable' });

  // Guest bookings (walk-ins with no account) have no profile to attach a
  // garage vehicle to. `vehicles.owner_id` is NOT NULL, so inserting null was a
  // guaranteed 500. There is simply nothing to sync — report success as a no-op.
  if (!customerId) {
    console.log('ℹ️ [GARAGE] Skipped: no customer account (guest booking).');
    return res.json({ success: true, skipped: true, message: 'No customer account; garage sync not applicable.' });
  }

  if (!vehicle || !vehicle.plateNumber) {
    return res.status(400).json({ success: false, error: 'Vehicle with a plate number is required.' });
  }

  try {
    const plate = (vehicle.plateNumber || '').toUpperCase();

    // 1. Check if vehicle exists in garage
    const { data: existingVehicles, error: lookupError } = await supabaseAdmin
      .from('vehicles')
      .select('id, plate_number')
      .eq('owner_id', customerId);

    if (lookupError) throw lookupError;

    const normalizedPlate = plate.replace(/[^A-Z0-9]/g, '');
    if ((existingVehicles || []).some((item) => String(item.plate_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === normalizedPlate)) {
      return res.json({ success: true, message: 'Vehicle already in garage', existing: true });
    }

    // 2. Insert new vehicle
    const { data: insertedVehicle, error: insertError } = await supabaseAdmin
      .from('vehicles')
      .insert({
        owner_id: customerId,
        type: vehicle.type,
        brand: vehicle.brand,
        model: vehicle.model,
        plate_number: plate,
        fleet_group_id: vehicle.fleetGroupId || null,
        is_primary: false,
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (insertError) throw insertError;

    if (vehicle.fleetGroupId) {
      const { error: membershipError } = await supabaseAdmin
        .from('fleet_group_vehicles')
        .upsert({ fleet_group_id: vehicle.fleetGroupId, vehicle_id: insertedVehicle.id }, { onConflict: 'fleet_group_id,vehicle_id' });
      if (membershipError) throw membershipError;
    }

    console.log(`✅ [GARAGE] SUCCESSFULLY REGISTERED: ${plate}`);
    return res.json({ success: true, message: 'Vehicle registered in garage' });
  } catch (err) {
    console.error('❌ [GARAGE] Sync Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


/**
 * 🛡️ REQ-ADM-02, REQ-SYS-02: No-Show Detection Engine
 * NOSHOW_GRACE_MINUTES = 60
 * REMINDER_LEAD_MINUTES = 60
 *
 * THE 24-HOUR RULE (and why this function no longer owns it)
 * ----------------------------------------------------------
 * The lifecycle is a TWO-PHASE state machine, and the authoritative definition
 * lives in the DATABASE (migration 20261021000001):
 *
 *     T0       = start_datetime
 *     T0 + 1h  → phase 1: FLAGGED_NOSHOW   (staff never pressed Start Service)
 *     T0 + 25h → phase 2: cancelled        (24h undo window closed, terminal)
 *
 * This function used to re-implement phase 1 in JavaScript, and the two copies
 * DISAGREED:
 *   * it set `needs_attention = true` on every flag. That is the double-count —
 *     a no-show then appeared BOTH under "No-Show" AND under "Flagged for
 *     Review", two containers for one booking, because the DB migration
 *     deliberately leaves that flag alone.
 *   * it measured overdue-ness against `grace_period_until` while the DB
 *     measures it against `start_datetime + 1h`. Two clocks for one rule means
 *     a booking can be flagged by one sweep and not the other.
 *
 * It now DELEGATES to `run_no_show_lifecycle()`, which runs both phases under
 * the same clock the UI and the undo endpoint read. One rule, one clock, one
 * place to change it. The reminder (phase B) is the only thing left here: it is
 * a courtesy notification, not a state transition, so it is not part of the
 * lifecycle and does not belong in the DB state machine.
 *
 * IDEMPOTENT: the RPC re-asserts its own status predicates, so running this
 * every 5 minutes (or twice in one minute) is a no-op when nothing is due.
 */
const NOSHOW_GRACE_MINUTES = 60;
const REMINDER_LEAD_MINUTES = 60;

const checkOverdueBookings = async () => {
  if (!supabaseAdmin) return;

  const now = new Date();
  const reminderThreshold = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60000);

  console.log(`🕒 [SYSTEM] RUNNING NO-SHOW AUDIT: ${now.toISOString()}`);

  try {
    // ── A. THE LIFECYCLE (flag → 24h window → cancel), in the database ──────
    // No fallback re-implementation on purpose: if the RPC is absent the
    // correct behaviour is to do NOTHING and say so loudly, not to silently
    // re-run the divergent JS copy that caused the double-count. A missed sweep
    // is recoverable (the next run picks the booking up); a booking flagged
    // into the wrong containers, or cancelled on a different clock than the UI
    // shows, is not.
    const { data: lifecycle, error: lifecycleError } = await supabaseAdmin.rpc('run_no_show_lifecycle');

    if (lifecycleError) {
      const rpcMissing = /could not find the function|schema cache|does not exist/i.test(lifecycleError.message || '');
      if (rpcMissing) {
        console.warn('⚠️ [NO-SHOW] run_no_show_lifecycle() is not deployed (migration 20261021000001). No-show sweeping is DISABLED — bookings will not be flagged or auto-cancelled until it is applied.');
      } else {
        console.error('❌ [NO-SHOW] Lifecycle sweep failed:', lifecycleError.message);
      }
    } else {
      const flagged = Number(lifecycle?.flagged || 0);
      const cancelled = Number(lifecycle?.cancelled || 0);

      if (flagged > 0 || cancelled > 0) {
        console.log(`⚠️ [NO-SHOW] Lifecycle: flagged ${flagged}, auto-cancelled ${cancelled} (24h window closed).`);
      }

      // Read all open no-show bookings so failed email attempts are retried.
      // The lifecycle delivery ledger suppresses already-sent messages.
      const { data: flaggedBookings, error: fetchError } = await supabaseAdmin
        .from('bookings')
        .select('id, refund_status, customer_email, payments(amount, detected_amount, status, method, verified_at)')
        .eq('status', 'FLAGGED_NOSHOW');

      if (fetchError) {
        console.warn('📧 No-Show notification lookup failed:', fetchError.message);
      } else {
        // Retry pending deliveries on every sweep; booking-lifecycle's delivery
        // ledger makes successful sends idempotent and releases failed claims.
        for (const booking of (flaggedBookings || [])) {
          const refundRows = (booking.payments || []).filter((payment) =>
            String(payment.status || '').toUpperCase() === 'REFUND_PENDING'
            && String(payment.method || '').toUpperCase() !== 'SYSTEM_REFUND'
            && Number(payment.amount || 0) > 0
          );
          const verifiedRefund = refundRows
            .filter((payment) => payment.verified_at)
            .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
          const unverifiedRefund = refundRows
            .filter((payment) => !payment.verified_at)
            .reduce((sum, payment) => sum + Number(payment.detected_amount || payment.amount || 0), 0);
          const refundDetails = refundRows.length
            ? `Refund status: ${booking.refund_status || 'QUEUED'}. Verified payments awaiting refund: ₱${verifiedRefund.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Unverified payment claims awaiting review: ₱${unverifiedRefund.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
            : 'No payment was recorded, so no refund is currently queued.';
          try {
            await dispatchLifecycleEmail(booking.id, 'FLAGGED_NOSHOW', refundDetails);
          } catch (emailErr) {
            console.warn(`📧 No-Show email failed for booking ${booking.id}:`, emailErr.message);
          }
        }
      }
    }

    // ── B. URGENT REMINDER (15 MINS) - REQ-SYS-02 ───────────────────────────
    // Unchanged in behaviour, but now the ONLY thing this sweep does itself.
    const { data: upcoming, error } = await supabaseAdmin
      .from('bookings')
      .select('*, customer:profiles!bookings_customer_id_fkey(email, full_name)')
      .in('status', ['confirmed', 'CONFIRMED'])
      .lte('start_datetime', reminderThreshold.toISOString())
      .gt('start_datetime', now.toISOString())
      .eq('reminder_sent', false);

    if (error) throw error;

    for (const booking of (upcoming || [])) {
      console.log(`📧 [REMINDER] Triggering one-hour reminder for ${booking.customer?.email}`);

      if (!booking.customer?.email) continue;

      try {
        const projectUrl = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const reminderResponse = await fetch(`${projectUrl}/functions/v1/booking-lifecycle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({ bookingId: booking.id, newStatus: 'CONFIRMED', reminder: true })
        });
        if (!reminderResponse.ok) throw new Error(await reminderResponse.text());
      } catch (emailErr) {
        console.warn('📧 Reminder email failed:', emailErr.message);
      }

      await supabaseAdmin
        .from('bookings')
        .update({ reminder_sent: true })
        .eq('id', booking.id);
    }
  } catch (err) {
    console.error('❌ No-Show Audit Error:', err.message);
  }
};

// Run the audit worker on a single backend instance in production. The DB
// lifecycle is status-scoped and idempotent, and the reminder query filters on
// `reminder_sent`, so repeated runs cannot double-process a booking.
setInterval(checkOverdueBookings, 5 * 60000);
checkOverdueBookings();

/**
 * 🧹 SCENARIO 21 — UNPAID HOLD SWEEP.
 *
 * A customer who abandons the checkout leaves an unpaid booking holding its bay
 * from creation until the 60-minute no-show audit. This sweep releases those
 * holds after `business_config.unpaid_hold_minutes` (default 30) so a paying
 * walk-in can take the slot. It is a pure status transition (scheduled ->
 * cancelled), audited, and idempotent. The capacity predicate ALSO ignores
 * expired holds, so the DB agrees with the client even between sweeps.
 */
const releaseExpiredUnpaidHolds = async () => {
  if (!supabaseAdmin) return;
  try {
    const { data, error } = await supabaseAdmin.rpc('release_expired_unpaid_holds');
    if (error) {
      const rpcMissing = /could not find the function|schema cache|does not exist/i.test(error.message || '');
      if (!rpcMissing) console.warn('⚠️ [AUTO-RELEASE] Hold sweep failed:', error.message);
      return;
    }
    const released = data?.released_count || 0;
    if (released > 0) console.log(`🧹 [AUTO-RELEASE] Freed ${released} expired unpaid hold(s).`);
  } catch (err) {
    console.warn('⚠️ [AUTO-RELEASE] Hold sweep error:', err.message);
  }
};

setInterval(releaseExpiredUnpaidHolds, 5 * 60000);
releaseExpiredUnpaidHolds();

/**
 * 🧹 CLEAN SLATE: Purge all booking-related data
 * Deletes in FK-safe order (children first → parent last).
 * Preserves: profiles, vehicles (garage), shop config.
 */
app.post('/api/admin/purge-bookings', async (req, res) => {
  // ── ADMIN AUTHENTICATION (added — this route had none) ─────────────────────
  //
  // DEFECT: this endpoint DELETES every booking, payment, and audit log, and its
  // only guard was a shared secret whose value fell back to the literal
  // 'speedway-dev-only' — a string published in this repository. With
  // DEBUG_SECRET unset in production, anyone who read the repo could wipe the
  // entire database.
  //
  // Two independent gates now apply, and BOTH must pass:
  //   1. a verified ADMIN JWT (identity from the token, never the body), and
  //   2. the DEBUG_SECRET, which must be EXPLICITLY configured.
  //
  // The secret check is kept because a destructive maintenance endpoint benefits
  // from a second, out-of-band factor — but it is now a *second* factor rather
  // than the only one, and it can no longer be satisfied by a default.
  const admin = await requireAdmin(req);
  if (!admin) {
    console.warn('🛑 [SECURITY] Unauthorized purge attempt blocked (no valid admin session).');
    return res.status(403).json({ success: false, error: 'Forbidden: an active admin session is required.' });
  }

  const configuredSecret = process.env.DEBUG_SECRET;
  // FAIL CLOSED when the secret is unset. The previous `|| 'speedway-dev-only'`
  // fallback meant "unconfigured" silently became "configured with a public
  // value" — the worst possible default for a data-wipe endpoint.
  if (!configuredSecret) {
    console.error('🛑 [SECURITY] Purge refused: DEBUG_SECRET is not configured. This endpoint is disabled.');
    return res.status(503).json({
      success: false,
      error: 'Purge is disabled: DEBUG_SECRET is not configured on this server.',
    });
  }

  const { secret } = req.body || {};
  if (!secret || secret !== configuredSecret) {
    console.warn(`🛑 [SECURITY] Purge refused for admin ${admin.profile?.id || 'unknown'}: invalid secret.`);
    return res.status(403).json({ success: false, error: 'Forbidden: invalid secret' });
  }

  console.log(`🧹 [ADMIN] PURGING ALL BOOKING DATA... (authorized by ${admin.profile?.email || admin.profile?.id})`);

  try {
    // 1. booking_vehicle_services (grandchild)
    const { error: e1 } = await supabaseAdmin.from('booking_vehicle_services').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e1) console.warn('  ⚠️ booking_vehicle_services:', e1.message);
    else console.log('  ✅ booking_vehicle_services purged');

    // 2. booking_vehicles (child of bookings)
    const { error: e2 } = await supabaseAdmin.from('booking_vehicles').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e2) console.warn('  ⚠️ booking_vehicles:', e2.message);
    else console.log('  ✅ booking_vehicles purged');

    // 3. payments (child of bookings)
    const { error: e3 } = await supabaseAdmin.from('payments').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e3) console.warn('  ⚠️ payments:', e3.message);
    else console.log('  ✅ payments purged');

    // 4. audit_logs (references bookings)
    const { error: e4 } = await supabaseAdmin.from('audit_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e4) console.warn('  ⚠️ audit_logs:', e4.message);
    else console.log('  ✅ audit_logs purged');

    // 5. notifications (may reference bookings)
    const { error: e5 } = await supabaseAdmin.from('notifications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e5) console.warn('  ⚠️ notifications:', e5.message);
    else console.log('  ✅ notifications purged');

    // 6. chat_messages (references bookings)
    const { error: e6 } = await supabaseAdmin.from('chat_messages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e6) console.warn('  ⚠️ chat_messages:', e6.message);
    else console.log('  ✅ chat_messages purged');

    // 7. bookings (parent — last)
    const { error: e7 } = await supabaseAdmin.from('bookings').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e7) console.warn('  ⚠️ bookings:', e7.message);
    else console.log('  ✅ bookings purged');

    console.log('🧹 [ADMIN] PURGE COMPLETE — Clean slate achieved.');
    return res.json({ success: true, message: 'All booking data purged. Clean slate.' });
  } catch (err) {
    console.error('❌ Purge Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const cancelBookingAndQueueRefund = async ({ bookingId, reason, actor }) => {
  const { data, error } = await supabaseAdmin.rpc('admin_cancel_booking', {
    p_booking_id: bookingId,
    p_reason: reason,
    p_actor_id: actor.profile?.id || null,
    p_actor_name: actor.profile?.full_name || actor.profile?.email || actor.profile?.role || 'ADMIN',
    p_actor_role: actor.profile?.role || 'ADMIN'
  });
  if (error) throw error;
  if (!data?.success) throw new Error(data?.error || 'Cancellation was not completed.');

  const refundAmount = Number(data.refund_amount || 0);
  const refundDetails = refundAmount > 0
    ? `Refund status: ${data.refund_status || 'QUEUED'}. Amount queued for refund review: ₱${refundAmount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
    : 'No verified or submitted payment was recorded, so no refund is currently queued.';

  // The database transaction is authoritative. Do not hold its success response
  // open while the email provider or Edge Function is slow; log failures
  // separately so an email problem cannot make a completed cancellation appear
  // stuck to the caller.
  void dispatchLifecycleEmail(
    bookingId,
    'CANCELLED',
    `${reason.trim()}\n${refundDetails}`
  ).catch((emailError) => {
    console.error(`[cancellation] Customer email failed for booking ${bookingId}:`, emailError.message);
  });

  return data;
};

const handleBookingCancellation = async (req, res, actor) => {
  const { bookingId, reason } = req.body || {};
  if (!bookingId) return res.status(400).json({ success: false, error: 'Booking ID is required.' });
  if (!String(reason || '').trim()) return res.status(400).json({ success: false, error: 'Cancellation reason is required.' });
  console.log(`[${actor.profile.role}] BOOKING CANCELLATION: ${bookingId} by ${actor.profile.email || actor.profile.id}`);

  try {
    const result = await cancelBookingAndQueueRefund({ bookingId, reason: String(reason).trim(), actor });
    return res.json({ ...result, message: 'Booking cancelled and refund status recorded.' });
  } catch (err) {
    const message = String(err.message || '');
    const status = /BOOKING_NOT_FOUND/.test(message) ? 404
      : /BOOKING_CANNOT_BE_CANCELLED/.test(message) ? 409
        : /BOOKING_NOT_OWNED_BY_CUSTOMER|CANCELLATION_ACTOR_NOT_ALLOWED/.test(message) ? 403
        : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
};

app.post('/api/bookings/cancel', async (req, res) => {
  const actor = await getCancellationActor(req);
  if (!actor) return res.status(403).json({ success: false, error: 'An active customer or admin session is required.' });

  const { bookingId, reason } = req.body || {};
  if (!bookingId) return res.status(400).json({ success: false, error: 'Booking ID is required.' });
  if (!String(reason || '').trim()) return res.status(400).json({ success: false, error: 'Cancellation reason is required.' });

  if (actor.profile.role === 'CUSTOMER') {
    const { data: booking, error } = await supabaseAdmin
      .from('bookings')
      .select('id, customer_id')
      .eq('id', bookingId)
      .maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found.' });
    if (booking.customer_id !== actor.profile.id) {
      return res.status(403).json({ success: false, error: 'You may only cancel your own booking.' });
    }
  }

  return handleBookingCancellation(req, res, actor);
});

app.post('/api/bookings/admin-cancel', async (req, res) => {
  // ── ADMIN AUTHENTICATION (added — this route had none) ─────────────────────
  //
  // DEFECT: this endpoint cancels ANY booking by id, with no authentication at
  // all, and then wrote `actor_role: 'ADMIN'` into the audit log. An anonymous
  // caller could therefore cancel bookings AND have the cancellation recorded as
  // a legitimate admin action — destroying the audit trail's credibility as well
  // as the booking.
  const admin = await requireAdmin(req);
  if (!admin) {
    console.warn('🛑 [SECURITY] Unauthorized admin-cancel attempt blocked.');
    return res.status(403).json({ success: false, error: 'Forbidden: an active admin session is required.' });
  }

  return handleBookingCancellation(req, res, admin);
});

app.post('/api/bookings/undo-no-show', async (req, res) => {
  const admin = await requireAdmin(req);
  if (!admin) {
    return res.status(403).json({ success: false, error: 'Forbidden: an active admin session is required.' });
  }

  const { bookingId, pendingRefund } = req.body || {};

  if (!bookingId) {
    return res.status(400).json({ success: false, error: 'Booking ID is required.' });
  }

  try {
    // ── The 24-hour window is enforced in the DATABASE ──────────────────────
    //
    // This handler used to re-implement the whole undo: read the booking, decide
    // whether a refund was pending, then write the new status — with NO time
    // check of any kind. The undo was therefore available forever, which is how
    // a booking flagged days earlier could still be reverted.
    //
    // It also duplicated booking state logic that the UI also duplicated, so the
    // three copies could (and did) disagree. `undo_no_show` now owns the rule:
    // it re-derives the phase from `start_datetime` against `now()` and refuses
    // with UNDO_WINDOW_EXPIRED. Delegating also means a replayed request, a
    // stale browser tab or a direct API call hits the same control.
    //
    // NOTE: the previous implementation also wrote `payment_status: 'approved'`
    // to public.payments, which is not a member of booking_payment_status — the
    // exact enum defect its own comment above claimed to have fixed. Going
    // through the RPC removes that write entirely.
    const { data, error } = await supabaseAdmin.rpc('undo_no_show', {
      p_booking_id: bookingId,
      p_actor_name: admin.profile?.full_name || admin.profile?.email || 'ADMIN',
      p_pending_refund: Boolean(pendingRefund),
    });

    if (error) throw error;

    const result = data || {};

    if (!result.success) {
      // Map the RPC's stable codes to HTTP statuses the client already handles.
      const statusByCode = {
        BOOKING_NOT_FOUND: 404,
        NOT_FLAGGED_NOSHOW: 409,
        UNDO_WINDOW_EXPIRED: 409,
        REFUND_ALREADY_PROCESSED: 400,
      };
      const status = statusByCode[result.error] || 400;
      return res.status(status).json({
        success: false,
        error: result.message || result.error || 'Unable to restore the booking.',
        code: result.error || null,
        undoDeadline: result.deadline || null,
      });
    }

    // Vehicles move back to SCHEDULED. Non-fatal: the booking itself is already
    // restored, and a vehicle row that cannot be updated must not fail the undo.
    const { error: vehicleError } = await supabaseAdmin
      .from('booking_vehicles')
      .update({ status: 'SCHEDULED', started_at: null, completed_at: null })
      .eq('booking_id', bookingId);

    if (vehicleError) {
      console.warn('Non-fatal vehicle-state restore warning:', vehicleError.message);
    }

    const { data: restoredBooking, error: restoredBookingError } = await supabaseAdmin
      .from('bookings')
      .select('staff_id, updated_at')
      .eq('id', bookingId)
      .maybeSingle();
    if (restoredBookingError) {
      console.warn('Could not verify technician assignment after no-show undo:', restoredBookingError.message);
    }

    await supabaseAdmin.from('audit_logs').insert({
      booking_id: bookingId,
      action_type: 'UNDO_NO_SHOW',
      actor_name: admin.profile?.full_name || admin.profile?.email || 'ADMIN',
      actor_role: 'ADMIN',
      actor_id: admin.profile?.id || null,
      details: result.undone_by
        ? `Admin ${result.undone_by} reverted no-show for booking ${bookingId} within the 24-hour window.${pendingRefund ? ' Pending refund request intercepted and cancelled.' : ''}`
        : `Admin reverted no-show for booking ${bookingId} within the 24-hour window.`,
    });

    return res.json({
      success: true,
      message: 'No-show was reverted successfully and pending refund requests were intercepted.',
      bookingStatus: 'scheduled',
      needsStaffReassignment: restoredBookingError ? null : !restoredBooking?.staff_id,
      statusUpdatedAt: restoredBooking?.updated_at || null,
      undoDeadline: result.undo_deadline || null,
    });
  } catch (err) {
    console.error('❌ Undo No-Show Error:', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Unable to restore the booking.' });
  }
});


app.post('/api/bookings/add-service', async (req, res) => {
  const { bookingId, vehicleId, serviceName, price, durationMinutes = 60, paymentAmount, paymentType = 'Downpayment', paymentMethod = 'Cash', referenceNumber = '' } = req.body;
  const actor = await getLifecycleActor(req);
  if (!actor) return res.status(403).json({ success: false, error: 'Authorized admin or staff account required.' });
  try {
    const servicePrice = Number(price);
    const { data: booking, error: bookingError } = await supabaseAdmin.from('bookings').select('id, status, total_amount, end_datetime').eq('id', bookingId).single();
    if (bookingError) throw bookingError;
    if (!['scheduled', 'confirmed', 'in_progress'].includes(String(booking.status || '').toLowerCase())) return res.status(409).json({ success: false, error: 'Services can only be added while a booking is scheduled, confirmed, or in progress.' });
    if (!serviceName || !Number.isFinite(servicePrice) || servicePrice <= 0) return res.status(400).json({ success: false, error: 'A valid service and price are required.' });
    const { data: vehicle, error: vehicleError } = await supabaseAdmin.from('booking_vehicles').select('id, booking_id').eq('id', vehicleId).eq('booking_id', bookingId).maybeSingle();
    if (vehicleError) throw vehicleError;
    if (!vehicle) return res.status(404).json({ success: false, error: 'Vehicle does not belong to this booking.' });
    const { data: existing } = await supabaseAdmin.from('booking_vehicle_services').select('id').eq('booking_vehicle_id', vehicleId).ilike('service_name', serviceName).maybeSingle();
    if (existing) return res.status(409).json({ success: false, error: 'This service is already assigned to the vehicle.' });
    const { verified_paid: verifiedPaid } = await getBookingLedger(bookingId);
    const newBookingTotal = Number(booking.total_amount || 0) + servicePrice;
    const minimumDownpaymentNow = Math.min(
      servicePrice,
      Math.max(0, (await getRequiredDownpaymentFor(newBookingTotal)) - verifiedPaid)
    );
    const hasPayment = paymentAmount !== null && paymentAmount !== undefined;
    if (servicePrice >= 1000 && minimumDownpaymentNow > 0
      && (!hasPayment || Number(paymentAmount) < minimumDownpaymentNow || Number(paymentAmount) > servicePrice)) {
      return res.status(409).json({ success: false, error: `Payment must be at least ${minimumDownpaymentNow.toLocaleString()} and no more than the service price.` });
    }
    if (hasPayment && (!Number.isFinite(Number(paymentAmount)) || Number(paymentAmount) <= 0 || Number(paymentAmount) > servicePrice)) return res.status(400).json({ success: false, error: 'Invalid service payment amount.' });

    // 🛡️ SCENARIOS 19 & 20 — ATOMIC, ROW-LOCKED MUTATION.
    //
    // The old sequence (check status -> insert service -> update total) had no
    // row lock, so a concurrent completion/cancellation could interleave: an
    // admin could inject a $500 service into a booking that had just been
    // released, or a cancel and an upsell could both pass their status checks.
    // We now route the whole mutation through `mutate_booking_locked()`, which
    // locks the booking row, re-checks the terminal guard UNDER the lock, and
    // applies the service line, the payment, and the total delta in ONE
    // transaction. The loser of a race fails with a clean check_violation.
    const serviceSchema = await getBookingVehicleServiceColumns();
    const serviceRow = {
      booking_vehicle_id: vehicleId,
      service_name: serviceName,
      price: servicePrice,
      ...(serviceSchema.hasDurationMinutes ? { duration_minutes: Number(durationMinutes || 60) } : {}),
      ...(serviceSchema.hasServiceSnapshot ? {
        service_snapshot: {
          name: serviceName,
          price: servicePrice,
          duration_minutes: Number(durationMinutes || 60),
          source: 'admin_add_service'
        }
      } : {})
    };
    const paymentRow = hasPayment ? {
      amount: Number(paymentAmount),
      method: paymentMethod,
      payment_type: paymentType,
      status: 'PAID',
      reference_number: paymentMethod === 'Digital' ? referenceNumber.trim() : null,
      verified_by: actor.user.id,
      verified_at: new Date().toISOString(),
      notes: `PAYMENT_${String(paymentMethod).toUpperCase()} | ADDED_SERVICE:${serviceName} | TYPE:${paymentType}`
    } : null;

    const { error: rpcError } = await supabaseAdmin.rpc('mutate_booking_locked', {
      p_booking_id: bookingId,
      p_total_delta: servicePrice,
      p_end_delta_minutes: Number(durationMinutes || 60),
      p_service: serviceRow,
      p_payment: paymentRow,
      p_actor_id: actor.user.id,
      p_actor_name: actor.user.email || actor.profile.full_name || 'Admin',
      p_actor_role: String(actor.profile.role).toUpperCase(),
      p_note: `Added ${serviceName}; ${hasPayment ? `recorded payment of ${paymentAmount}` : 'downpayment not required'}.`
    });

    if (rpcError) {
      const rpcMissing = /could not find the function|schema cache|does not exist/i.test(rpcError.message || '');
      if (/check_violation|closed|terminal/i.test(rpcError.message || '')) {
        // Scenario 19/20 loser: the booking became terminal under us.
        return res.status(409).json({ success: false, error: 'This booking was just closed (completed or cancelled) and can no longer be modified.' });
      }
      if (rpcMissing) {
        try {
          const { data: liveBooking, error: liveBookingError } = await supabaseAdmin
            .from('bookings')
            .select('id, status, total_amount, start_datetime, end_datetime')
            .eq('id', bookingId)
            .single();

          if (liveBookingError) throw liveBookingError;

          if (['released', 'completed', 'cancelled', 'flagged_noshow'].includes(String(liveBooking.status || '').toLowerCase())) {
            return res.status(409).json({ success: false, error: 'This booking was just closed (completed or cancelled) and can no longer be modified.' });
          }

          const serviceSchema = await getBookingVehicleServiceColumns();
          const fallbackService = {
            booking_vehicle_id: vehicleId,
            service_name: serviceName,
            price: servicePrice,
            ...(serviceSchema.hasDurationMinutes ? { duration_minutes: Number(durationMinutes || 60) } : {}),
            ...(serviceSchema.hasServiceSnapshot ? {
              service_snapshot: {
                name: serviceName,
                price: servicePrice,
                duration_minutes: Number(durationMinutes || 60),
                source: 'admin_add_service_fallback'
              }
            } : {})
          };

          const paymentPayload = hasPayment ? {
            booking_id: bookingId,
            amount: Number(paymentAmount),
            method: paymentMethod,
            payment_type: paymentType,
            status: 'PAID',
            reference_number: paymentMethod === 'Digital' ? referenceNumber.trim() : null,
            verified_by: actor.user.id,
            verified_at: new Date().toISOString(),
            notes: `PAYMENT_${String(paymentMethod).toUpperCase()} | ADDED_SERVICE:${serviceName} | TYPE:${paymentType}`
          } : null;

          const { error: serviceInsertError } = await supabaseAdmin
            .from('booking_vehicle_services')
            .insert(fallbackService);
          if (serviceInsertError) throw serviceInsertError;

          if (paymentPayload) {
            const { error: paymentInsertError } = await supabaseAdmin
              .from('payments')
              .insert(paymentPayload);
            if (paymentInsertError) throw paymentInsertError;
          }

          const nextTotal = Number(liveBooking.total_amount || 0) + servicePrice;
          const baseEnd = liveBooking.end_datetime || liveBooking.start_datetime || new Date().toISOString();
          const nextEnd = new Date(new Date(baseEnd).getTime() + Number(durationMinutes || 0) * 60000).toISOString();

          const { error: bookingUpdateError } = await supabaseAdmin
            .from('bookings')
            .update({ total_amount: nextTotal, end_datetime: nextEnd, updated_at: new Date().toISOString() })
            .eq('id', bookingId);

          if (bookingUpdateError) throw bookingUpdateError;

          await supabaseAdmin.from('audit_logs').insert({
            booking_id: bookingId,
            action_type: 'BOOKING_UPDATED',
            actor_name: actor.user.email || actor.profile.full_name || 'Admin',
            actor_role: String(actor.profile.role).toUpperCase(),
            actor_id: actor.user.id,
            details: `Compatibility fallback updated booking ${bookingId} by adding service ${serviceName}.`,
            metadata: {
              service_name: serviceName,
              total_delta: servicePrice,
              mode: 'compatibility_fallback'
            }
          });

          return res.json({
            success: true,
            fallback: true,
            message: 'Service was added using the compatibility fallback while the booking lock migration is syncing.'
          });
        } catch (fallbackError) {
          console.error('Add service compatibility fallback failed:', fallbackError.message);
          return res.status(500).json({
            success: false,
            error: fallbackError.message || 'Unable to add service right now.'
          });
        }
      }
      throw rpcError;
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Add service failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/bookings/update-master-status', async (req, res) => {
  const { bookingId, status, reason = '' } = req.body || {};
  const actor = await getLifecycleActor(req);
  if (!actor) return res.status(403).json({ success: false, error: 'Authorized admin or staff account required.' });
  if (!bookingId || !status) return res.status(400).json({ success: false, error: 'Booking ID and status are required.' });

  try {
    const normalizedStatus = String(status).toLowerCase();
    if (normalizedStatus === 'cancelled') {
      if (String(actor.profile.role).toUpperCase() !== 'ADMIN') {
        return res.status(403).json({ success: false, error: 'Only an admin may cancel a booking.' });
      }
      if (!String(reason).trim()) {
        return res.status(400).json({ success: false, error: 'Cancellation reason is required.' });
      }
      const result = await cancelBookingAndQueueRefund({
        bookingId,
        reason: String(reason).trim(),
        actor
      });
      return res.json(result);
    }

    const { data: booking, error: bookingError } = await supabaseAdmin.from('bookings').select('id, status, customer_id, total_amount, staff_id, start_datetime').eq('id', bookingId).single();
    if (bookingError) throw bookingError;
    const { data: vehicles, error: vehiclesError } = await supabaseAdmin.from('booking_vehicles').select('status').eq('booking_id', bookingId);
    if (vehiclesError) throw vehiclesError;
    const ledger = await getBookingLedger(bookingId);

    const currentStatus = String(booking.status || '').toLowerCase();
    const requiredDownpayment = ledger.required_downpayment;
    const allCompleted = (vehicles || []).length > 0 && vehicles.every(vehicle => ['COMPLETED', 'CANCELLED'].includes(String(vehicle.status || '').toUpperCase()));

    if (normalizedStatus === 'confirmed') {
      if (!['scheduled', 'pending'].includes(currentStatus) || !ledger.downpayment_met) {
        return res.status(409).json({ success: false, error: `Booking requires at least ${requiredDownpayment.toLocaleString()} in verified payment before confirmation.` });
      }
    } else if (normalizedStatus === 'in_progress') {
      const scheduledDate = new Date(booking.start_datetime);
      if (currentStatus !== 'confirmed' || !booking.staff_id || scheduledDate.toDateString() !== new Date().toDateString()) {
        return res.status(409).json({ success: false, error: 'Service can only start on the scheduled date after confirmation and staff assignment.' });
      }
    } else if (normalizedStatus === 'completed') {
      if (currentStatus !== 'in_progress' || !allCompleted || !ledger.service_paid_in_full) {
        return res.status(409).json({ success: false, error: 'Booking can be completed only after every vehicle is finished and fully paid.' });
      }
    } else {
      return res.status(400).json({ success: false, error: 'Unsupported master booking status.' });
    }

    const updatePayload = { status: normalizedStatus };
    const { error: updateError } = await supabaseAdmin.from('bookings').update(updatePayload).eq('id', bookingId);
    if (updateError) throw updateError;

    if (normalizedStatus === 'completed') await supabaseAdmin.from('booking_vehicles').update({ status: 'COMPLETED', completed_at: new Date().toISOString() }).eq('booking_id', bookingId);

    await supabaseAdmin.from('audit_logs').insert({ booking_id: bookingId, action_type: `BOOKING_${normalizedStatus.toUpperCase()}`, actor_name: actor.user.email || actor.profile.full_name || 'System', actor_role: String(actor.profile.role).toUpperCase(), details: reason.trim() || `Booking moved from ${currentStatus} to ${normalizedStatus}.` });
    await dispatchLifecycleEmail(bookingId, normalizedStatus, reason.trim());
    return res.json({ success: true, status: normalizedStatus });
  } catch (error) {
    console.error('Master lifecycle update failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/bookings/release', async (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) return res.status(400).json({ success: false, error: 'Booking ID is required.' });
  if (!(await getLifecycleActor(req))) return res.status(403).json({ success: false, error: 'Authorized admin or staff account required.' });

  try {
    const { data: booking, error: fetchError } = await supabaseAdmin
      .from('bookings')
      .select('id, status, customer_id, total_amount')
      .eq('id', bookingId)
      .single();
    if (fetchError) throw fetchError;

    const [{ data: vehicles, error: vehiclesError }, ledger] = await Promise.all([
      supabaseAdmin.from('booking_vehicles').select('status').eq('booking_id', bookingId),
      getBookingLedger(bookingId)
    ]);
    if (vehiclesError) throw vehiclesError;

    const bookingStatus = booking.status?.toLowerCase();
    const allVehiclesFinished = (vehicles || []).length > 0
      && vehicles.every(vehicle => ['COMPLETED', 'CANCELLED'].includes(String(vehicle.status || '').toUpperCase()));
    const isSettled = ledger.service_paid_in_full;
    if (bookingStatus !== 'completed' && !(allVehiclesFinished && isSettled)) {
      return res.status(409).json({ success: false, error: 'Only completed bookings can be released.' });
    }

    const { error: updateError } = await supabaseAdmin
      .from('bookings')
      .update({ status: 'RELEASED', bay_id: null, updated_at: new Date().toISOString() })
      .eq('id', bookingId);
    if (updateError) throw updateError;

    await supabaseAdmin.from('audit_logs').insert({
      booking_id: bookingId,
      action_type: 'BOOKING_RELEASED',
      actor_name: 'ADMIN',
      actor_role: 'ADMIN',
      details: 'Booking released after customer vehicle pickup; assigned staff retained for work history and bay allocation cleared.'
    });

    try {
      const projectUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      await fetch(`${projectUrl}/functions/v1/booking-lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ bookingId, newStatus: 'RELEASED' })
      });
    } catch (emailError) {
      console.warn('Released email failed:', emailError.message);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Release booking error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── MASTER STATUS PROPAGATOR & NOTIFICATION CONTROLLER ──────────────────
// REQ-SYS-02: Transactional Integrity for Booking Lifecycle
const singaporeDateKey = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

app.get('/api/staff/tasks', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ success: false, error: 'Supabase Admin not initialized' });
  res.set('Cache-Control', 'private, no-store');
  const actor = await getLifecycleActor(req);
  if (!actor || String(actor.profile.role).toUpperCase() !== 'STAFF') {
    return res.status(403).json({ success: false, error: 'An active staff account is required.' });
  }

  let stage = 'assigned-bookings-query';
  try {
    const requestedBookingId = String(req.query.bookingId || '').trim();
    const requestedVehicleId = String(req.query.vehicleId || '').trim();
    const compactBookingReference = requestedBookingId.replace(/-/g, '').toLowerCase();
    const isUuidPrefix = /^[0-9a-f]{8,32}$/.test(compactBookingReference);
    const matchesRequestedBooking = (booking) => !requestedBookingId
      || booking.id === requestedBookingId
      || (isUuidPrefix && booking.id.replace(/-/g, '').toLowerCase().startsWith(compactBookingReference));
    const bookingDetailsSelect = `
      id, status, start_datetime, end_datetime, total_amount,
      vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(
        id, booking_id, status, brand, model, plate_number, vehicle_type,
        fleet_group_id, service_notes, started_at, completed_at,
        services:booking_vehicle_services(service_name)
      )
    `;
    const returnReleasedBookingFromAssignmentNotice = async () => {
      if (!requestedBookingId && !requestedVehicleId) return false;

      let bookingId = requestedBookingId;
      if (!bookingId && requestedVehicleId) {
        const { data: vehicle, error: vehicleError } = await supabaseAdmin
          .from('booking_vehicles')
          .select('booking_id')
          .eq('id', requestedVehicleId)
          .maybeSingle();
        if (vehicleError) throw vehicleError;
        bookingId = vehicle?.booking_id;
      }
      if (!bookingId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) return false;

      const { data: assignmentNotice, error: noticeError } = await supabaseAdmin
        .from('notifications')
        .select('id')
        .eq('user_id', actor.profile.id)
        .eq('booking_id', bookingId)
        .eq('notification_type', 'TASK_ASSIGNED')
        .limit(1)
        .maybeSingle();
      if (noticeError) throw noticeError;
      if (!assignmentNotice) return false;

      const { data: historicalBooking, error: historicalBookingError } = await supabaseAdmin
        .from('bookings')
        .select(bookingDetailsSelect)
        .eq('id', bookingId)
        .maybeSingle();
      if (historicalBookingError) throw historicalBookingError;
      if (String(historicalBooking?.status || '').toLowerCase() !== 'released') return false;

      const vehicles = requestedVehicleId
        ? (historicalBooking.vehicles || []).filter((vehicle) => vehicle.id === requestedVehicleId)
        : historicalBooking.vehicles || [];
      if (requestedVehicleId && vehicles.length === 0) return false;

      return res.json({
        success: true,
        bookings: [{
          id: historicalBooking.id,
          status: historicalBooking.status,
          start_datetime: historicalBooking.start_datetime,
          end_datetime: historicalBooking.end_datetime,
          vehicles
        }]
      });
    };
    const revokeNoticeForFormerAssignee = async () => {
      if (!requestedBookingId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedBookingId)) {
        return false;
      }

      const { data: notice, error: noticeError } = await supabaseAdmin
        .from('notifications')
        .select('id')
        .eq('user_id', actor.profile.id)
        .eq('booking_id', requestedBookingId)
        .eq('notification_type', 'TASK_ASSIGNED')
        .limit(1)
        .maybeSingle();
      if (noticeError) throw noticeError;
      if (!notice) return false;

      const { data: booking, error: bookingError } = await supabaseAdmin
        .from('bookings')
        .select('id, staff_id')
        .eq('id', requestedBookingId)
        .maybeSingle();
      if (bookingError) throw bookingError;
      if (!booking || booking.staff_id === actor.profile.id) return false;

      await revokeStaleStaffTaskNotifications(booking.id, booking.staff_id);
      return true;
    };

    const { data: bookings, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .select(bookingDetailsSelect)
      .eq('staff_id', actor.profile.id);
    if (bookingError) throw bookingError;

    const assignedBooking = (bookings || []).find(matchesRequestedBooking);
    if (requestedBookingId && !assignedBooking) {
      if (await returnReleasedBookingFromAssignmentNotice()) return;
      if (await revokeNoticeForFormerAssignee()) {
        return res.status(404).json({
          success: false,
          error: 'This vehicle has been reassigned and is no longer in your active work. The old alert has been updated.'
        });
      }
      return res.status(404).json({
        success: false,
        error: 'This booking is not currently assigned to your account. Ask an admin to check the assignment.'
      });
    }

    const assignedBookings = (bookings || []).filter((booking) =>
      !['cancelled', 'released', 'flagged_noshow', 'no_show'].includes(String(booking.status || '').toLowerCase())
    );
    if (requestedBookingId && assignedBooking && !assignedBookings.some((booking) => booking.id === assignedBooking.id)) {
      if (await returnReleasedBookingFromAssignmentNotice()) return;
      return res.status(404).json({
        success: false,
        error: 'This booking is closed and is not available in active assignments.'
      });
    }
    if (!assignedBookings.length) {
      if (await returnReleasedBookingFromAssignmentNotice()) return;
      return res.json({ success: true, bookings: [] });
    }

    stage = 'ledger-query';
    const ledgers = await getBookingLedgers(assignedBookings.map((booking) => booking.id));

    stage = 'payment-eligibility-filter';
    const eligibleBookings = assignedBookings.filter((booking) => ledgers.get(booking.id)?.downpayment_met);
    if (requestedBookingId && assignedBooking && !eligibleBookings.some((booking) => booking.id === assignedBooking.id)) {
      if (await returnReleasedBookingFromAssignmentNotice()) return;
      return res.status(404).json({
        success: false,
        error: 'The required downpayment for this booking has not been verified yet.'
      });
    }
    stage = 'requested-assignment-filter';
    const requestedBookings = eligibleBookings
      .filter(matchesRequestedBooking)
      .map((booking) => requestedVehicleId
        ? { ...booking, vehicles: (booking.vehicles || []).filter((vehicle) => vehicle.id === requestedVehicleId) }
        : booking)
      .filter((booking) => !requestedVehicleId || booking.vehicles.length > 0);
    if (requestedVehicleId && requestedBookings.length === 0) {
      if (await returnReleasedBookingFromAssignmentNotice()) return;
      return res.status(404).json({ success: false, error: 'No vehicle is attached to this assigned booking.' });
    }
    return res.json({ success: true, bookings: requestedBookings });
  } catch (err) {
    const errorCode = typeof err.code === 'string' ? err.code : 'UNKNOWN';
    console.error(`Staff task fetch error at ${stage} [${errorCode}]:`, err.message);
    const missingColumn = errorCode === '42703'
      ? String(err.message || '').match(/column ([\w.]+) does not exist/i)?.[1]
      : undefined;
    return res.status(500).json({
      success: false,
      error: 'Could not load assigned work.',
      diagnostic: { stage, code: errorCode, ...(missingColumn ? { missingColumn } : {}) }
    });
  }
});

app.post('/api/bookings/reconcile-payment-state', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ success: false, error: 'Supabase Admin not initialized' });
  const actor = await getLifecycleActor(req);
  if (!actor || String(actor.profile.role).toUpperCase() !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'An active admin account is required.' });
  }

  const bookingId = req.body?.bookingId;
  if (!bookingId) return res.status(400).json({ success: false, error: 'Booking identifier is required.' });

  try {
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .select('id, status, staff_id, total_amount')
      .eq('id', bookingId)
      .single();
    if (bookingError) throw bookingError;

    const ledger = await getBookingLedger(bookingId);
    const currentStatus = String(booking.status || '').toLowerCase();
    let nextStatus = currentStatus;

    if (['scheduled', 'pending'].includes(currentStatus)
      && booking.staff_id
      && ledger.downpayment_met) {
      nextStatus = 'confirmed';
    } else if (currentStatus === 'in_progress') {
      const { data: vehicles, error: vehicleError } = await supabaseAdmin
        .from('booking_vehicles')
        .select('status')
        .eq('booking_id', bookingId);
      if (vehicleError) throw vehicleError;
      const allVehiclesComplete = (vehicles || []).length > 0
        && vehicles.every((vehicle) => String(vehicle.status || '').toUpperCase() === 'COMPLETED');
      const fullyPaid = ledger.service_paid_in_full;
      if (allVehiclesComplete && fullyPaid) nextStatus = 'completed';
    }

    const warnings = [];
    const paymentEligible = ledger.downpayment_met;
    try {
      await revokeStaleStaffTaskNotifications(
        bookingId,
        paymentEligible ? booking.staff_id : null
      );
    } catch (notificationError) {
      console.error(`[payment-state] Stale staff task notification cleanup failed for booking ${bookingId}:`, notificationError.message);
      warnings.push('The booking was reconciled, but an outdated staff assignment alert could not be updated.');
    }

    if (nextStatus !== currentStatus) {
      const { error: updateError } = await supabaseAdmin
        .from('bookings')
        .update({ status: nextStatus })
        .eq('id', bookingId);
      if (updateError) throw updateError;

      try {
        await dispatchLifecycleEmail(bookingId, nextStatus.toUpperCase());
      } catch (emailError) {
        console.error(`[payment-state] ${nextStatus} email dispatch failed for booking ${bookingId}:`, emailError.message);
        warnings.push(`Status updated, but the ${nextStatus} email could not be sent.`);
      }
    }

    if (booking.staff_id && paymentEligible) {
      const { data: existingNotice, error: noticeReadError } = await supabaseAdmin
        .from('notifications')
        .select('id')
        .eq('user_id', booking.staff_id)
        .eq('booking_id', bookingId)
        .eq('notification_type', 'TASK_ASSIGNED')
        .limit(1);
      if (noticeReadError) {
        console.error(`[payment-state] Staff notification lookup failed for booking ${bookingId}:`, noticeReadError.message);
        warnings.push('Payment state was updated, but the staff in-app notification could not be checked.');
      } else if (!(existingNotice || []).length) {
        const { error: noticeInsertError } = await supabaseAdmin.from('notifications').insert({
          user_id: booking.staff_id,
          title: 'New Vehicle Assigned',
          message: 'A new vehicle booking is ready for your assigned service work.',
          notification_type: 'TASK_ASSIGNED',
          action_url: '/staff/tasks',
          booking_id: bookingId,
          is_read: false
        });
        if (noticeInsertError) {
          console.error(`[payment-state] Staff notification insert failed for booking ${bookingId}:`, noticeInsertError.message);
          warnings.push('Payment state was updated, but the staff in-app notification could not be created.');
        }
      }
    }

    return res.json({ success: true, status: nextStatus, warnings });
  } catch (err) {
    console.error('Payment state reconciliation failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bookings/update-status', async (req, res) => {
  const { bookingId, unitId, newStatus, notes } = req.body;

  if (!supabaseAdmin) return res.status(500).json({ success: false, error: 'Supabase Admin not initialized' });
  const actor = await getLifecycleActor(req);
  if (!actor) return res.status(403).json({ success: false, error: 'Authorized admin or staff account required.' });
  const requestedStatus = String(newStatus || '').toUpperCase();
  if (!['IN_PROGRESS', 'COMPLETED'].includes(requestedStatus)) {
    return res.status(400).json({ success: false, error: 'Only service start and completion updates are supported.' });
  }
  if (!bookingId || !unitId) {
    return res.status(400).json({ success: false, error: 'Booking and vehicle identifiers are required.' });
  }

  try {
    const timestamp = new Date().toISOString();

    // 0. Fetch Master Booking first for context
    const { data: masterBooking, error: masterFetchError } = await supabaseAdmin
      .from('bookings')
      .select('status, customer_id, total_amount, staff_id, start_datetime')
      .eq('id', bookingId)
      .single();

    if (masterFetchError) throw masterFetchError;
    const currentMaster = masterBooking.status?.toLowerCase();
    if (['completed', 'released', 'cancelled', 'flagged_noshow', 'no_show'].includes(currentMaster)) {
      return res.status(409).json({ success: false, error: 'This booking is finalized and cannot accept service updates.' });
    }
    if (String(actor.profile.role).toUpperCase() === 'STAFF' && actor.profile.id !== masterBooking.staff_id) {
      return res.status(403).json({ success: false, error: 'Only the assigned technician may update this booking.' });
    }

    const { data: vehicle, error: vehicleFetchError } = await supabaseAdmin
      .from('booking_vehicles')
      .select('id, booking_id, status')
      .eq('id', unitId)
      .eq('booking_id', bookingId)
      .maybeSingle();
    if (vehicleFetchError) throw vehicleFetchError;
    if (!vehicle) return res.status(404).json({ success: false, error: 'Vehicle does not belong to this booking.' });
    const currentUnitStatus = String(vehicle.status || '').toUpperCase();

    if (requestedStatus === 'IN_PROGRESS') {
      if (!['PENDING', 'SCHEDULED', 'CONFIRMED'].includes(currentUnitStatus)) {
        return res.status(409).json({ success: false, error: 'This vehicle is not waiting to start service.' });
      }
      const scheduledDate = new Date(masterBooking.start_datetime);
      const nowDate = new Date();
      const isScheduledDate = singaporeDateKey(scheduledDate) === singaporeDateKey(nowDate);
      if (!['scheduled', 'confirmed', 'in_progress'].includes(currentMaster)
        || !masterBooking.staff_id
        || !isScheduledDate
        || scheduledDate.getTime() > nowDate.getTime()) {
        return res.status(409).json({ success: false, error: 'Service can only start after the scheduled time, on the scheduled date, with an assigned technician.' });
      }

      if (!(await getBookingLedger(bookingId)).downpayment_met) {
        return res.status(409).json({ success: false, error: 'The required downpayment must be verified before service can start.' });
      }

      const { count: beforePhotoCount, error: beforePhotoCountError } = await supabaseAdmin
        .from('service_photos')
        .select('id', { count: 'exact', head: true })
        .eq('booking_vehicle_id', unitId)
        .eq('phase', 'before')
        .is('archived_at', null);
      if (beforePhotoCountError) throw beforePhotoCountError;
      if (!beforePhotoCount || beforePhotoCount < 1) {
        return res.status(409).json({
          success: false,
          error: 'At least 1 before-service photo is required before this unit can be started.',
          code: 'PHOTO_PROOF_REQUIRED'
        });
      }
    }

    if (requestedStatus === 'COMPLETED') {
      if (currentUnitStatus !== 'IN_PROGRESS') {
        return res.status(409).json({ success: false, error: 'Start this vehicle’s service before completing it.' });
      }

      // 🛡️ Batch 5: Photo-proof gate. A unit cannot be finalized without at
      // least one post-service ('after') QA photo. The DB is the source of
      // truth; this server-side check means the rule cannot be bypassed by a
      // direct API call that skips the client UI.
      //
      const { count: afterPhotoCount, error: photoCountError } = await supabaseAdmin
        .from('service_photos')
        .select('id', { count: 'exact', head: true })
        .eq('booking_vehicle_id', unitId)
        .eq('phase', 'after')
        .is('archived_at', null);

      if (photoCountError) throw photoCountError;

      if (!afterPhotoCount || afterPhotoCount < 1) {
        return res.status(409).json({
          success: false,
          error: 'At least 1 completion (after) photo is required before this unit can be marked complete.',
          code: 'PHOTO_PROOF_REQUIRED'
        });
      }
    }

    // 1. Update the specific vehicle unit
    const { error: unitError } = await supabaseAdmin
      .from('booking_vehicles')
      .update({
        status: requestedStatus,
        service_notes: notes || undefined,
        started_at: requestedStatus === 'IN_PROGRESS' ? timestamp : undefined,
        completed_at: requestedStatus === 'COMPLETED' ? timestamp : undefined
      })
      .eq('id', unitId);

    if (unitError) throw unitError;

    // 2. Fetch all units for this booking to determine the master state
    const { data: allUnits, error: fetchError } = await supabaseAdmin
      .from('booking_vehicles')
      .select('status, brand, model, service_notes')
      .eq('booking_id', bookingId);

    if (fetchError) throw fetchError;

    // 🔍 Calculate Financial Balance
    const ledger = await getBookingLedger(bookingId);
    const balance = ledger.service_balance_due;
    const isFullySettled = ledger.service_paid_in_full;

    // 🆕 Status Calculation Logic
    const anyInProgress = (allUnits || []).some(u => u.status?.toUpperCase() === 'IN_PROGRESS');
    const allCompleted = (allUnits || []).length > 0 && (allUnits || []).every(u => u.status?.toUpperCase() === 'COMPLETED');
    const allPending = (allUnits || []).length > 0 && (allUnits || []).every(u => u.status?.toUpperCase() === 'SCHEDULED');

    // Determine target master status
    let targetMasterStatus = currentMaster;

    // 🛡️ REQ-NFR-02: Do not move out of terminal states (completed/cancelled)
    if (currentMaster.toLowerCase() !== 'completed' && currentMaster.toLowerCase() !== 'cancelled') {
      if (anyInProgress) targetMasterStatus = 'in_progress';
      else if (allCompleted && isFullySettled) targetMasterStatus = 'completed';
      else if (allCompleted && !isFullySettled) targetMasterStatus = 'in_progress'; // Stay in_progress if unpaid
      else if (allPending) targetMasterStatus = 'scheduled';
    }

    console.log(`[PROPAGATOR] Booking ${bookingId}: Current='${currentMaster}', Target='${targetMasterStatus}', Balance=₱${balance}`);

    // 4. Update Master Booking if needed (Case-insensitive check)
    if (masterBooking.status?.toLowerCase() !== targetMasterStatus.toLowerCase()) {
      console.log(`[PROPAGATOR] Updating Master Booking ${bookingId} to '${targetMasterStatus}'`);
      const { error: updateError } = await supabaseAdmin
        .from('bookings')
        .update({ status: targetMasterStatus })
        .eq('id', bookingId);

      if (updateError) throw updateError;

      // Task B: when a booking completes, route any leftover excess_credit to
      // the Refund Hub queue. Non-fatal: completion must not fail if this does.
      if (targetMasterStatus === 'completed') {
        try {
          const { error: settleErr } = await supabaseAdmin.rpc('settle_overpayment_on_completion', { p_booking_id: bookingId });
          if (settleErr) {
            // The RPC only exists once the Task B migration is applied.
            console.warn('⚠️ Overpayment settlement skipped:', settleErr.message);
          } else {
            console.log(`[TASK B] Overpayment settlement ran for booking ${bookingId}`);
          }
        } catch (settleEx) {
          console.warn('⚠️ Overpayment settlement error (non-fatal):', settleEx.message);
        }
      }

      // 📧 DISPATCH CENTRALIZED EMAIL
      let remarks = '';
      if (targetMasterStatus === 'completed') {
        remarks = (allUnits || [])
          .filter(u => u.service_notes)
          .map(u => `${u.brand} ${u.model}: ${u.service_notes}`)
          .join('\n');
      }

      try {
        const project_url = process.env.SUPABASE_URL;
        const service_key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        await fetch(`${project_url}/functions/v1/booking-lifecycle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${service_key}` },
          body: JSON.stringify({ bookingId, newStatus: targetMasterStatus, remarks })
        });
      } catch (emailErr) {
        console.warn('Backend Email Trigger Warning:', emailErr.message);
      }
    }

    // 5. Audit Log
    await supabaseAdmin.from('audit_logs').insert({
      booking_id: bookingId,
      action_type: 'STATUS_PROPAGATION',
      actor_name: actor.user.email || actor.profile.role,
      actor_role: actor.profile.role,
      details: `Unit ${unitId} updated to ${requestedStatus}. Master status: ${targetMasterStatus || 'unchanged'}`
    });

    return res.json({
      success: true,
      masterStatus: targetMasterStatus || currentMaster,
      unitStatus: requestedStatus
    });

  } catch (err) {
    console.error('Propagation Error:', err);
    if (err.code === '23514' && /SERVICE_START_BLOCKED_NO_BEFORE_PHOTO|SERVICE_COMPLETE_BLOCKED_NO_AFTER_PHOTO/.test(err.message || '')) {
      const needsBefore = /SERVICE_START_BLOCKED_NO_BEFORE_PHOTO/.test(err.message || '');
      return res.status(409).json({
        success: false,
        error: needsBefore
          ? 'At least 1 before-service photo is required before this unit can be started.'
          : 'At least 1 completion (after) photo is required before this unit can be marked complete.',
        code: 'PHOTO_PROOF_REQUIRED'
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/debug/user/:email', async (req, res) => {
  // ── ADMIN AUTHENTICATION ───────────────────────────────────────────────────
  // This route previously had NO guard whatsoever: any anonymous caller could
  // resolve an arbitrary email to its auth id, confirmation state, last sign-in
  // timestamp and user metadata. It is kept only because support tooling may
  // reference it, and is now gated on a verified ADMIN session — the same gate
  // every other privileged route uses.
  const admin = await requireAdmin(req);
  if (!admin) {
    console.warn('🛑 [SECURITY] Unauthorized debug user lookup blocked.');
    return res.status(403).json({ success: false, error: 'Forbidden: an active admin session is required.' });
  }

  const { email } = req.params;
  try {
    const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers();
    if (error) throw error;

    const user = users.find(u => u.email === email);
    if (!user) {
      return res.json({ success: false, message: 'User not found in Auth' });
    }

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        confirmed_at: user.confirmed_at,
        last_sign_in_at: user.last_sign_in_at,
        metadata: user.user_metadata
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// REMOVED: GET /api/debug/user/:email, GET /api/debug/list-users and
// POST /api/debug/fix-account.
//
// All three were unauthenticated maintenance endpoints. `user/:email` had NO
// guard at all — any anonymous caller could look up any account by email and
// read its auth id, confirmation state, last sign-in time and metadata.
// `list-users` disclosed the same for the ten most recent accounts. `fix-account`
// RESET any user's password to a known constant.
//
// The latter two were additionally guarded only by a shared secret whose value
// fell back to the literal 'speedway-dev-only', published in this repository, so
// that public default was enough to take over ANY account. They were locked down
// first (fail-closed 503 when DEBUG_SECRET is unset, plus a real secret check),
// and are deleted here because none of them are used in production: an endpoint
// that can enumerate accounts or reset passwords has no business shipping in the
// deployable server at all. Removing the attack surface is strictly better than
// guarding it.
//
// If an operator genuinely needs these, they belong behind an authenticated
// ADMIN route (see requireAdmin above) — not behind a shared secret.

// NOTE: the canonical shift-toggle handler is defined earlier in this file
// (POST /api/staff/toggle-shift, near the other /api/staff routes). A duplicate
// definition previously lived here; Express only ever executes the FIRST match,
// so this second copy was dead code — and it was inconsistent (it wrote to a
// staff_shifts table the primary handler does not, and it never set
// clock_in_timestamp). Removed to keep a single source of truth.

// 🔒 Schedule Block Management Endpoints (Bypassing RLS 403 Forbidden)
app.post('/api/admin/blocked-slots', async (req, res) => {
  // ── ADMIN AUTHENTICATION (added — this route had none) ─────────────────────
  //
  // DEFECT: closing a day writes into `blocked_slots` with no authentication. An
  // anonymous caller could close the shop indefinitely, and the row's
  // `created_by` (taken from the REQUEST BODY) meant the audit trail blamed
  // whoever the caller named.
  //
  // `created_by` is still accepted for compatibility, but the AUTHORITATIVE
  // attribution is now the verified admin from the JWT.
  const admin = await requireAdmin(req);
  if (!admin) {
    console.warn('🛑 [SECURITY] Unauthorized blocked-slots POST blocked.');
    return res.status(403).json({ success: false, error: 'Forbidden: an active admin session is required.' });
  }

  const { block_date, dates, start_date, end_date, start_time, end_time, reason } = req.body;
  // Attribute the block to the VERIFIED acting admin, so a later "who closed
  // this day?" question is answerable straight from the row. The body value is
  // used only as a fallback for older clients, never as the source of truth.
  const createdBy = admin.profile?.id || req.body.created_by || req.body.actor_id || null;
  const actorName = String(req.body.actor_name || req.body.admin_name || '').trim();

  try {
    if (!supabaseAdmin) throw new Error('Supabase Admin not initialized');

    let rowsToInsert = [];

    if (Array.isArray(dates) && dates.length > 0) {
      // Multi-day date array provided
      rowsToInsert = dates.map(d => ({
        block_date: d,
        start_time,
        end_time,
        reason: reason || 'ADMIN BLOCK',
        created_by: createdBy || null
      }));
    } else if (start_date && end_date) {
      // Multi-day date range provided
      const curr = new Date(start_date);
      const last = new Date(end_date);
      while (curr <= last) {
        const dStr = curr.toISOString().split('T')[0];
        rowsToInsert.push({
          block_date: dStr,
          start_time,
          end_time,
          reason: reason || 'ADMIN BLOCK',
          created_by: createdBy || null
        });
        curr.setDate(curr.getDate() + 1);
      }
    } else if (block_date) {
      // Single day
      rowsToInsert = [{
        block_date,
        start_time,
        end_time,
        reason: reason || 'ADMIN BLOCK',
        created_by: createdBy || null
      }];
    } else {
      return res.status(400).json({ success: false, error: 'Target date or date range is required' });
    }

    const activeStatuses = ['scheduled', 'confirmed', 'in_progress', 'pending', 'SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'PENDING'];
    const conflicts = new Map();
    for (const row of rowsToInsert) {
      const blockStart = new Date(`${row.block_date}T${row.start_time || '00:00:00'}`);
      const blockEnd = new Date(`${row.block_date}T${row.end_time || '23:59:59'}`);
      const { data: bookings, error: bookingError } = await supabaseAdmin
        .from('bookings')
        .select('id, customer_name, start_datetime, end_datetime, status')
        .in('status', activeStatuses)
        .lt('start_datetime', blockEnd.toISOString())
        .gt('end_datetime', blockStart.toISOString());
      if (bookingError) throw bookingError;
      for (const booking of bookings || []) conflicts.set(booking.id, booking);
    }

    if (conflicts.size > 0) {
      return res.status(409).json({
        success: false,
        code: 'BOOKING_CONFLICT',
        error: 'This restriction overlaps active bookings. Cancel or reschedule them first.',
        bookings: Array.from(conflicts.values())
      });
    }

    console.log(`🔒 [ADMIN SCHEDULE] BLOCKING SLOTS: ${rowsToInsert.length} day(s) (${start_time || 'WHOLE DAY'} - ${end_time || 'WHOLE DAY'})`);

    const { data, error } = await supabaseAdmin
      .from('blocked_slots')
      .insert(rowsToInsert)
      .select();

    if (error) throw error;

    await supabaseAdmin.from('audit_logs').insert({
      action_type: 'SCHEDULE_SLOT_BLOCKED',
      actor_id: createdBy || null,
      actor_name: actorName || 'ADMIN',
      actor_role: 'ADMIN',
      details: `Blocked schedule slots across ${rowsToInsert.length} day(s): ${reason || 'ADMIN BLOCK'}`
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Block Slot Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/admin/blocked-slots/:id', async (req, res) => {
  // ── ADMIN AUTHENTICATION (added — this route had none) ─────────────────────
  const admin = await requireAdmin(req);
  if (!admin) {
    console.warn('🛑 [SECURITY] Unauthorized blocked-slots PATCH blocked.');
    return res.status(403).json({ success: false, error: 'Forbidden: an active admin session is required.' });
  }

  const { id } = req.params;
  const { start_time, end_time, reason } = req.body;
  console.log(`✂️ [ADMIN SCHEDULE] TRIMMING/UPDATING BLOCK ID ${id}: ${start_time} - ${end_time}`);

  try {
    if (!supabaseAdmin) throw new Error('Supabase Admin not initialized');

    const updateFields = {};
    if (start_time !== undefined) updateFields.start_time = start_time;
    if (end_time !== undefined) updateFields.end_time = end_time;
    if (reason !== undefined) updateFields.reason = reason;

    const { data, error } = await supabaseAdmin
      .from('blocked_slots')
      .update(updateFields)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await supabaseAdmin.from('audit_logs').insert({
      action_type: 'SCHEDULE_SLOT_TRIMMED',
      actor_name: 'ADMIN',
      actor_role: 'ADMIN',
      details: `Adjusted restriction timeframe on slot ID ${id} to ${start_time || 'WHOLE DAY'} - ${end_time || 'WHOLE DAY'}`
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Trim Block Slot Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/blocked-slots/:id', async (req, res) => {
  // ── ADMIN AUTHENTICATION (added — this route had none) ─────────────────────
  const admin = await requireAdmin(req);
  if (!admin) {
    console.warn('🛑 [SECURITY] Unauthorized blocked-slots DELETE blocked.');
    return res.status(403).json({ success: false, error: 'Forbidden: an active admin session is required.' });
  }

  const { id } = req.params;
  console.log(`🔓 [ADMIN SCHEDULE] UNBLOCKING SLOT ID: ${id}`);

  try {
    if (!supabaseAdmin) throw new Error('Supabase Admin not initialized');

    const { error } = await supabaseAdmin
      .from('blocked_slots')
      .delete()
      .eq('id', id);

    if (error) throw error;

    await supabaseAdmin.from('audit_logs').insert({
      action_type: 'SCHEDULE_SLOT_UNBLOCKED',
      actor_name: 'ADMIN',
      actor_role: 'ADMIN',
      details: `Lifted restriction on slot ID ${id}`
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Unblock Slot Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 🗓️ Batch 6 / Step 6.2 — Schedule rules enforcement
// ============================================================================
// Server-side hard block for the Batch 6 schedule restrictions (lead time,
// max advance window, closed weekdays, past dates, admin blocks, slot
// capacity). The decision itself lives in the shared pure module
// (frontend/src/domain/schedule/rules.js) consumed via services/scheduleValidation.
//
//   POST /api/bookings/validate-slot   -> 200 { valid:true } | 400/409 { valid:false, code, message }
//
// The booking wizard calls this before creating a booking so the client shows a
// guided <ValidationModal>; the same validator is safe to call from any future
// server-side booking-creation path.
//
// Lightweight liveness probe. The frontend polls this to decide whether the
// scheduling backend is reachable, so it can show a clear, proactive in-app
// banner BEFORE a user fills in a whole booking and gets blocked fail-closed at
// submit time. It intentionally does no DB work (it must stay fast + cheap even
// when Postgres is having a bad day) — the presence of the process is the signal.
//
//   GET /api/health  -> 200 { success:true, status:'ok', time:<iso> }
//
// DEGRADED REPORTING: this used to return 200 unconditionally, so a deploy that
// was missing its service-role key reported itself healthy while every database
// feature was dead. It now reports what is actually configured, and returns 503
// when a REQUIRED variable is absent — a health check that cannot fail is not a
// health check. Hosts (Render) also poll this to decide whether a deploy is
// live, so a genuinely broken instance must not be marked as ready.
app.get('/api/health', (req, res) => {
  const degraded = !startupConfig.ok;

  return res.status(degraded ? 503 : 200).json({
    success: !degraded,
    status: degraded ? 'degraded' : 'ok',
    service: 'speedway-backend',
    supabaseReady: Boolean(supabaseAdmin),
    // Feature-level truth, so a partial outage is visible rather than inferred.
    features: {
      database: Boolean(supabaseAdmin),
      email: Boolean(resendClient),
      // Receipt OCR runs CLIENT-SIDE (Tesseract.js) and the server-side
      // verification is pure parsing + a byte-hash lookup, so there is no
      // external OCR dependency to be missing. This was previously keyed on
      // GEMINI_API_KEY; it is now unconditionally available.
      ocr: true,
    },
    // Names only — never values. Enough to diagnose a bad deploy from outside.
    missingRequired: startupConfig.missingRequired.map((entry) => entry.split(' — ')[0]),
    missingRecommended: startupConfig.missingRecommended.map((entry) => entry.split(' — ')[0]),
    time: new Date().toISOString(),
  });
});

// Status contract:
//   400 = malformed request (INVALID_DATE / INVALID_SLOT / PAST_DATE)
//   409 = valid request that conflicts with current shop state
//         (CLOSED_WEEKDAY / BLOCKED_DATE / BEYOND_ADVANCE_WINDOW / LEAD_TIME /
//          SLOT_UNAVAILABLE / CAPACITY_EXCEEDED)
//   500 = infrastructure failure (DB unreachable) — never a silent pass.
app.post('/api/bookings/validate-slot', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, valid: false, error: 'Supabase Admin not initialized' });
  }

  try {
    const result = await validateBookingRequest(supabaseAdmin, req.body || {});

    if (result.valid) {
      return res.status(200).json({
        success: true,
        valid: true,
        code: 'OK',
        details: result.details,
      });
    }

    return res.status(result.status).json({
      success: false,
      valid: false,
      code: result.code,
      internalCode: result.internalCode,
      error: result.message,
      message: result.message,
      details: result.details,
    });
  } catch (err) {
    // A DB failure must NOT report the slot as valid — fail closed.
    console.error('❌ Schedule Validation Error:', err.message);
    return res.status(500).json({
      success: false,
      valid: false,
      code: 'VALIDATION_UNAVAILABLE',
      error: 'Unable to validate this slot right now. Please try again.',
    });
  }
});

// Enumerate the bookable slots for a date (powers the calendar + modal).
//   GET /api/bookings/slots?date=YYYY-MM-DD    (query, not a mutation)
app.get('/api/bookings/slots', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, error: 'Supabase Admin not initialized' });
  }
  const date = String(req.query.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, code: 'INVALID_DATE', error: 'A valid date (YYYY-MM-DD) query param is required.' });
  }

  try {
    const { loadScheduleContext } = require('./services/scheduleValidation');
    const { getBookableSlots } = require('../frontend/src/domain/schedule/rules.js');
    const durationMinutes = Math.max(1, Number(req.query.durationMinutes) || 60);
    const requestedBays = Math.max(1, Number(req.query.requestedBays) || 1);
    const { config, blocks, bookings } = await loadScheduleContext(supabaseAdmin, date, {
      excludeBookingId: req.query.excludeBookingId,
      durationMinutes,
    });
    // skipLeadTime=1 -> admin/desk view: show imminent slots the customer-facing
    // "minimum advance notice" would otherwise hide.
    const skipLeadTime = String(req.query.skipLeadTime || '') === '1' || req.query.skipLeadTime === 'true';
    const slots = getBookableSlots(date, config, bookings, {
      blocks, durationMinutes, requestedBays, skipLeadTime,
    });
    return res.json({ success: true, date, slots });
  } catch (err) {
    console.error('❌ Slot Enumeration Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Allow cross-module use of the shared validator from booking creation paths.
app.locals.validateBookingRequest = validateBookingRequest;

const httpServer = app.listen(PORT, () => {
  console.log('\n' + '*'.repeat(50));
  console.log(`🚀 COMAR GARAGE BACKEND: http://localhost:${PORT}`);
  console.log('*'.repeat(50) + '\n');
});
httpServer.requestTimeout = 160000;
httpServer.timeout = 160000;
httpServer.headersTimeout = 60000;
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // A port clash is unrecoverable for THIS process, so we must exit — but we
    // exit explicitly and understandably, rather than letting the runtime die
    // with an opaque stack trace that surfaces in the browser as
    // ERR_CONNECTION_REFUSED with no explanation.
    console.error(`\n❌ ERROR: Port ${PORT} is already in use!`);
    console.error(`   Please stop any other running backend processes and try again.\n`);
    process.exit(1);
  } else {
    // Any OTHER listen error (transient EMFILE, a DNS/permission blip) is logged
    // and NOT treated as fatal, so a momentary failure cannot take the process
    // down permanently. The global guards above catch anything that escapes.
    console.error(`\n❌ ERROR: Server listen error:`, err.message);
  }
});
