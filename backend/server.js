const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
require('dotenv').config();

const { normalizeStatus, shouldRestoreGraceWindow } = require('./noShowRestoreLogic');
const { validateBookingRequest } = require('./services/scheduleValidation');
const { Resend } = require('resend');
const { buildEmailShell, send, sendBookingConfirmationEmail, sendPasswordResetEmail, sendAccountInviteEmail, sendAdminInviteEmail, sendInviteAccountEmail, sendEmergencyRecoveryEmail, sendQrChangeOtpEmail } = require('./services/emailService');
// EMAIL AUTH POLICY: single source of truth for LINK vs OTP per flow.
// See docs/EMAIL_AUTH_POLICY.md. Guards below keep UI copy and delivery in sync.
const { DELIVERY, assertDelivery } = require('./config/emailPolicy');
const { processReceiptOCR } = require('./services/ocrService');
const ocrGuard = require('./services/ocrGuard');
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const RESEND_FROM = process.env.RESEND_FROM || 'Speedway AutoxMoto <bookings@yourdomain.com>';

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
const PASSWORD_CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const PASSWORD_CIPHER_KEY = crypto.createHash('sha256').update(process.env.SUPABASE_SERVICE_ROLE_KEY || 'development-key').digest();

const calculateNetPaid = (payments = []) => {
  const positive = payments
    .filter(payment => ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(String(payment.status || '').toUpperCase()) && Number(payment.amount) > 0)
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const refunds = payments
    .filter(payment => (String(payment.method || '').toUpperCase() === 'SYSTEM_REFUND' && Number(payment.amount) < 0)
      || String(payment.status || '').toUpperCase() === 'REFUNDED')
    .reduce((sum, payment) => sum + Math.abs(Number(payment.amount || 0)), 0);
  return Math.max(0, positive - refunds);
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

// Configure Multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

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
 */
const requireAdmin = async (req) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || !supabaseAdmin) return null;
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return null;
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, role, is_active, email, full_name')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (!profile?.is_active) return null;
  if (String(profile.role || '').toUpperCase() !== 'ADMIN') return null;
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

const getRequiredDownpayment = (total) => {
  const amount = Number(total || 0);
  return Math.round(amount * (amount >= 2000 ? 0.5 : 0.3) * 100) / 100;
};

const dispatchLifecycleEmail = async (bookingId, newStatus, remarks = '') => {
  const projectUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${projectUrl}/functions/v1/send-status-email`, {
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
      subject = 'Verify Your Speedway Account';
      html = buildEmailShell({
        title: 'Verify Your Account',
        eyebrow: 'SECURITY CHECK',
        bodyHtml: `
          <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">Your verification code is:</p>
          <div style="font-size: 32px; font-weight: 900; letter-spacing: 5px; padding: 16px 18px; background: #f5f5f4; border-radius: 12px; color: #111827; display: inline-block; margin-bottom: 16px;">${data.otp}</div>
          <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.7;">This code expires in 10 minutes. Use it to complete your sign-in or account creation flow.</p>
        `,
        ctaLink: null,
        footerNote: 'Speedway Detail Studio | 39 Hunters ROTC, Barangay San Juan, Cainta, 1900 Rizal'
      });
      break;
    default:
      subject = 'Speedway AutoxMoto Update';
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

const buildReceiptPdfBuffer = ({ receiptNumber, customerName, bookingReference, issuedAt, paymentMethod, processedBy, customerContact, customerAddress, customerTaxId, items = [], subtotal = 0, discountAmount = 0, vatRate = 0.12 }) => {
  const safeSubtotal = Number(subtotal || 0);
  const safeDiscount = Number(discountAmount || 0);
  const vatableSales = Math.max(0, safeSubtotal - safeDiscount);
  const vatAmount = Math.max(0, vatableSales * vatRate);
  const totalDue = safeSubtotal - safeDiscount + vatAmount;
  const dateString = issuedAt ? new Date(issuedAt).toLocaleString() : new Date().toLocaleString();

  const lines = [
    'SPEEDWAY',
    'AutoxMoto Detail Studio',
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
    `Subtotal: ${formatCurrency(safeSubtotal)}`,
    `Discount / Promo: -${formatCurrency(safeDiscount)}`,
    `Vatable Sales: ${formatCurrency(vatableSales)}`,
    `VAT (12%): ${formatCurrency(vatAmount)}`,
    `Total Amount Due: ${formatCurrency(totalDue)}`,
    '',
    'This receipt is valid for tax and audit purposes.'
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

const buildReceiptEmailHtml = ({ customerName, bookingReference, receiptNumber, paidAmount, paymentMethod, issuedAt, items, subtotal, discountAmount, vatAmount, totalDue }) => {
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

  return `
    <div style="font-family: Inter, system-ui, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 16px; overflow: hidden; color: #111827;">
      <div style="background: #111827; color: #f9fafb; padding: 16px 20px; border-bottom: 1px solid #262626;">
        <div style="font-size: 18px; font-weight: 800; letter-spacing: 0.22em; text-transform: uppercase; text-align: center;">SPEEDWAY</div>
        <div style="font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; text-align: center; color: #d1d5db; margin-top: 6px;">AutoxMoto Detail Studio</div>
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
            <div style="font-size: 14px; font-weight: 700; color: #111827;">AutoxMoto Detail Studio</div>
            <div style="font-size: 12px; color: #4b5563; margin-top: 4px;">123 Auto Avenue, Mandaluyong City</div>
            <div style="font-size: 12px; color: #4b5563;">+63 917 123 4567 | hello@speedwaystudio.ph</div>
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

        <div style="max-width: 260px; margin-left: auto; border-top: 2px solid #111827; padding-top: 12px;">
          <div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #4b5563;"><span>Subtotal</span><span>${formatCurrency(subtotal)}</span></div>
          <div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #4b5563;"><span>Discount / Promo</span><span>- ${formatCurrency(discountAmount)}</span></div>
          <div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #4b5563;"><span>Vatable Sales</span><span>${formatCurrency(subtotal - discountAmount)}</span></div>
          <div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #4b5563;"><span>VAT (12%)</span><span>${formatCurrency(vatAmount)}</span></div>
          <div style="display: flex; justify-content: space-between; padding-top: 8px; font-size: 18px; font-weight: 800; color: #111827;"><span>Total Amount Due</span><span>${formatCurrency(totalDue)}</span></div>
        </div>
      </div>
      <div style="padding: 0 24px 24px; font-size: 12px; color: #4b5563; line-height: 1.6;">
        <p style="margin: 0;">Hi ${customerName},</p>
        <p style="margin: 10px 0 0;">Thank you for your payment. Your transaction has been processed successfully and the receipt is attached below for your records.</p>
      </div>
    </div>
  `;
};

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

    const customerEmail = customer?.email || booking.customer_email;
    const customerName = customer?.full_name || booking.customer_name || 'Customer';
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
        to: customer.email,
        subject: `BOOKING CONFIRMED: ${bookingId.substring(0, 8).toUpperCase()}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; border: 1px solid #eee; padding: 20px;">
            <h2 style="color: #A91B18; margin-top: 0;">SPEEDWAY DETAIL STUDIO</h2>
            <h3 style="text-transform: uppercase; border-bottom: 2px solid #eee; padding-bottom: 10px;">Booking Confirmation</h3>
            
            <p>Hi <strong>${customer.full_name}</strong>,</p>
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
              Please arrive 15 minutes before your scheduled slot. If you need to reschedule, contact us at +1 (555) SPEEDWAY.
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
    const subtotal = Number(payment.amount || booking.total_amount || 0);
    const discountAmount = Number(payment.discount_amount || 0);
    const vatRate = 0.12;
    const vatAmount = Math.max(0, (subtotal - discountAmount) * vatRate);
    const totalDue = subtotal - discountAmount + vatAmount;

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
      unitPrice: subtotal,
      lineTotal: subtotal,
    }];

    const receiptHtml = buildReceiptEmailHtml({
      customerName,
      bookingReference: booking.booking_id || bookingId,
      receiptNumber,
      paidAmount: subtotal,
      paymentMethod: payment.method || booking.payment_method || 'Digital / Online Payment',
      issuedAt,
      items,
      subtotal,
      discountAmount,
      vatAmount,
      totalDue,
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
      subtotal,
      discountAmount,
      vatRate,
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

  if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail) || !['ADMIN', 'STAFF', 'CUSTOMER'].includes(normalizedRole)) {
    console.error(`❌ [INVITE SYSTEM] REJECTED: Invalid email (${email}) or role (${role})`);
    return res.status(400).json({ success: false, error: 'Invalid invitation parameters' });
  }

  console.log(`🎟️ [INVITE SYSTEM] GENERATING FOR: ${normalizedEmail} (${normalizedRole})`);

  if (!supabaseAdmin) {
    return res.status(503).json({ success: false, error: 'Invitation service unavailable.' });
  }

  // NOTE: This legacy route is the GUEST-BOOKING path (a customer books and the
  // guest is auto-provisioned). It used to insert into a non-existent `invites`
  // table, which always threw — producing the 500 you saw. It now provisions a
  // real account through the SAME primitives as /api/admin/invite-account
  // (create_invited_account RPC → auth.admin.createUser → profiles upsert) and
  // delivers the branded temporary-credentials email via the Resend relay.
  try {
    const safeFirst = '';
    const safeLast = '';
    const fullName = normalizedEmail.split('@')[0];

    // 1. Duplicate guard.
    //
    //    IMPORTANT: this route is the GUEST-BOOKING path and runs WITHOUT an admin
    //    session, so it must NOT call the admin-guarded `create_invited_account`
    //    RPC — that function runs is_admin() and raises
    //    "Only administrators may invite accounts" (SQLSTATE P0001) for an
    //    anonymous caller, which is exactly the 500 we saw. Instead we do a
    //    direct, non-atomic duplicate check against profiles + auth.users, which
    //    is the correct primitive for the guest path.
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
    const loginLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
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
          <h2 style="color: #A91B18;">SPEEDWAY DETAIL STUDIO</h2>
          <h3 style="margin-top: 0; text-transform: uppercase;">WELCOME TO THE FLEET</h3>
          <p>Hi ${firstName},</p>
          <p>Thank you for creating an account with Speedway Detail Studio. Please confirm your email address to activate your customer portal.</p>
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

/**
 * 🤖 REQ-SYS-01: AI-Assisted OCR Verification
 * Uses Gemini for high-fidelity receipt auditing.
 *
 * Directive 1 & 2: FAIL-FAST, SHORT-CIRCUIT PIPELINE.
 *   1. Scan + match the recipient name first. If it does not match the shop's
 *      registered account, abort immediately with NAME_MISMATCH — no further
 *      amount/date/duplicate work is done for a receipt that is not ours.
 *   2. Only then evaluate amount, date, and reference uniqueness.
 * The response always carries an explicit { valid, reason, status } contract so
 * the checkout UI can hard-block submission on anything but MATCH_SUCCESS.
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
      return res.json({
        valid: false,
        reason: 'VERIFICATION_LOCKED',
        status: 'MANUAL_REVIEW',
        success: true,
        isNameMatch: null,
        isAmountMatch: null,
        isDateMatch: null,
        isDuplicate: false,
        isManualReview: true,
        manualReviewAllowed: true,
        data: {
          referenceNo: 'MANUAL_AUDIT_PENDING',
          amount: 0,
          date: new Date().toLocaleDateString(),
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

    console.log(`🤖 [AI OCR] SCANNING RECEIPT: ${req.file.originalname} (${req.file.size} bytes)`);

    // ── SC-17: perceptual image hash ───────────────────────────────────────
    // Computed server-side from the uploaded bytes so the SAME image reused on
    // another booking collides even when the reference number was manipulated.
    const imageHash = ocrGuard.computeImageHash(req.file.buffer);

    const ocrResult = await processReceiptOCR(req.file.buffer, req.file.mimetype || 'image/jpeg');
    const extractedData = {
      ...ocrResult,
      referenceNo: ocrResult.referenceNumber,
      date: ocrResult.timestamp,
      isReceipt: ocrResult.isValidReceipt
    };

    console.log(`✅ [AI OCR] EXTRACTION SUCCESSFUL:`, extractedData);

    // 🛡️ FINANCIAL INTEGRITY GUARD: Comparison Logic
    // Clean amount string if AI included '₱' or commas
    const rawAmountString = String(extractedData.amount || 0).replace(/[^0-9.]/g, '');
    const extractedAmount = parseFloat(rawAmountString) || 0;
    const requiredAmount = parseFloat(req.body.requiredAmount) || 0;
    const bookingId = req.body.bookingId;
    const paymentId = req.body.paymentId;
    const referenceNo = String(extractedData.referenceNo || '').trim();
    // The shop's registered payee name for THIS checkout (config.qr_account_name).
    // When the caller does not supply one the name gate cannot be evaluated, so
    // it is skipped (name check disabled) rather than failing every upload.
    const expectedRecipientName = String(req.body.expectedRecipientName || req.body.expected_recipient_name || '').trim();
    // 🛡️ SCENARIO 8 — GHOST QR CODE SWAP.
    // The checkout freezes the QR config onto the booking (active_qr_snapshot /
    // qr_snapshot_version). If the admin swaps the store QR image while a customer
    // sits on the checkout, the receipt that customer uploads was made against the
    // SUPERSEDED image. We accept the version the client paid against and compare
    // it to the LIVE config version. A mismatch does NOT auto-reject (the money may
    // genuinely be ours), but it is flagged for the admin and stamped onto the
    // payment so the discrepancy is visible instead of silently buried.
    const expectedQrVersion = Number(req.body.expectedQrVersion || req.body.expected_qr_version || 0);
    let liveQrVersion = 0;
    if (supabaseAdmin) {
      try {
        const { data: liveCfg } = await supabaseAdmin
          .from('business_config')
          .select('qr_config_version')
          .order('id')
          .limit(1)
          .maybeSingle();
        liveQrVersion = Number(liveCfg?.qr_config_version || 0);
      } catch (cfgErr) {
        console.warn('⚠️ [AI OCR] QR version lookup failed (non-fatal):', cfgErr.message);
      }
    }
    const qrVersionMismatch = Boolean(expectedQrVersion && liveQrVersion && expectedQrVersion !== liveQrVersion);
    if (qrVersionMismatch) {
      console.log(`⚠️ [OCR] QR_VERSION_MISMATCH: receipt paid against v${expectedQrVersion} but live config is v${liveQrVersion}. Flagging for admin review.`);
    }

    // ── STEP 1 (FAIL FAST): RECIPIENT NAME ──────────────────────────────────
    // If the payee on the receipt is not our shop, stop here. Parsing a
    // stranger's reference number, date, or amount is wasted compute and an
    // error we would only catch later anyway.
    const isNameMatch = recipientNameMatches(extractedData.recipient, expectedRecipientName);
    if (expectedRecipientName && !isNameMatch) {
      console.log(`⛔ [FAIL-FAST] NAME_MISMATCH: receipt '${extractedData.recipient || 'N/A'}' vs expected '${expectedRecipientName}'. Aborting before amount/date checks.`);
      return res.json({
        valid: false,
        reason: 'FLAGGED_NAME_MISMATCH',
        status: 'NAME_MISMATCH',
        success: true,
        isNameMatch: false,
        isAmountMatch: null,
        isDateMatch: null,
        isDuplicate: false,
        data: {
          ...extractedData,
          amount: extractedAmount,
          recipient: extractedData.recipient || 'N/A',
          expectedRecipientName,
          description: 'The recipient name on this receipt does not match our registered payment account.'
        }
      });
    }

    console.log(`✅ [STEP 1 PASSED] Name check: receipt '${extractedData.recipient || 'N/A'}' matched expected '${expectedRecipientName || 'N/A'}'. Proceeding to amount & reference scan.`);

    // Check for mismatch (handling minor precision differences)
    //
    // 🛡️ EDGE CASE FIX — ±₱1.00 TOLERANCE IS INCLUSIVE.
    // The spec is "±₱1.00": a receipt whose amount differs from the required
    // amount by exactly ₱1.00 (e.g. required ₱1000, receipt ₱999 or ₱1001) MUST
    // be ACCEPTED. The previous `< 1.0` was STRICTLY less-than, so a difference of
    // exactly 1.00 failed the check and valid money was rejected at the boundary.
    // We use `<= 1.0` so both endpoints of the ±1 tolerance are inclusive.
    const isAmountMatch = Math.abs(extractedAmount - requiredAmount) <= 1.0;

    // 🛡️ Section 2.1–2.3: DATE-MATCH ENFORCEMENT.
    // The receipt's transaction date must be TODAY. A stale or future-dated
    // receipt is not proof of this booking's payment, so it is flagged for review
    // even when the amount matches. We compare calendar days in local time and
    // tolerate the many text shapes an OCR pass can return (ISO, 'MM/DD/YYYY',
    // 'DD/MM/YYYY', 'Month D, YYYY').
    const parseReceiptDate = (value) => {
      if (!value) return null;
      const str = String(value).trim();
      const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      const slash = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
      if (slash) {
        let [, a, b, y] = slash.map(Number);
        if (y < 100) y += 2000;
        // Ambiguous MM/DD vs DD/MM: if the first value exceeds 12 it is the day.
        const month = a > 12 ? b : a;
        const day = a > 12 ? a : b;
        const d = new Date(y, month - 1, day);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      const parsed = new Date(str);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const receiptDate = parseReceiptDate(extractedData.date);

    // 🛡️ SC-8 FIX — MIDNIGHT-SPAN TOLERANCE (was: strict same-calendar-day).
    //
    // Previously the receipt date had to equal TODAY's calendar day exactly, so a
    // payment made at 11:58 PM and uploaded at 12:02 AM was REJECTED even though
    // the money was real — a pure clock-rollover artefact. We now accept any
    // receipt inside a symmetric time window (default ±24 h): the pre-midnight
    // receipt passes, while a genuinely stale (days-old) or future-dated receipt
    // is still flagged. A receipt with no readable date still cannot auto-verify.
    const dateCheck = ocrGuard.receiptDateWithinTolerance(receiptDate, new Date());
    const isDateMatch = dateCheck.ok;
    const isDateToday = isDateMatch && dateCheck.reason === 'WITHIN_TOLERANCE' && receiptDate
      && receiptDate.getFullYear() === new Date().getFullYear()
      && receiptDate.getMonth() === new Date().getMonth()
      && receiptDate.getDate() === new Date().getDate();

    // A payment reference is single-use. Check this before accepting the
    // receipt so the same transfer cannot be attached to another booking.
    let isDuplicate = false;
    let duplicateReason = null;

    if (referenceNo && supabaseAdmin) {
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

    // 🛡️ SC-17 FIX — IMAGE-HASH DUPLICATE DETECTION.
    // The reference number is attacker-controllable (a reused receipt can be
    // re-scanned and the OCR biased toward a fresh reference). The IMAGE BYTES
    // are not: hashing the uploaded buffer server-side catches the exact same
    // image being submitted to a DIFFERENT booking, even with a different (or
    // fabricated) reference number. We compare against existing receipt hashes.
    let usedImageHash = false;
    if (imageHash && supabaseAdmin) {
      // The hash is persisted into payments.ocr_metadata.image_hash (jsonb) so no
      // schema change is required; we scan recent receipt rows for a collision.
      const { data: hashMatches, error: hashError } = await supabaseAdmin
        .from('payments')
        .select('id, booking_id')
        .not('receipt_url', 'is', null)
        .filter('ocr_metadata->>image_hash', 'eq', imageHash)
        .limit(1);

      if (hashError && !/schema cache|does not exist/i.test(hashError.message || '')) {
        console.warn('⚠️ [OCR] Image-hash duplicate check failed (non-fatal):', hashError.message);
      } else if (Array.isArray(hashMatches) && hashMatches.length > 0) {
        const matched = hashMatches[0];
        // A rescan of the SAME payment is not a duplicate of itself.
        if (!paymentId || matched.id !== paymentId) {
          usedImageHash = true;
          isDuplicate = true;
          duplicateReason = 'IMAGE_REUSED';
        }
      }
    }

    // Duplicates are rejected immediately; amount, receipt-validity, OR date
    // issues remain available for staff review rather than being silently accepted.
    const finalStatus = isDuplicate
      ? 'REJECTED_DUPLICATE'
      : (!isAmountMatch || !isDateMatch || !extractedData.isReceipt || qrVersionMismatch ? 'Flagged for Review' : 'Confirmed');

    // ── SC-18: failure circuit breaker ─────────────────────────────────────
    // A cleanly-read, well-formed receipt clears the streak. An unreadable or
    // invalid receipt counts toward the lock that forces manual review.
    if (extractedData.isReceipt && isAmountMatch && isDateMatch) {
      ocrGuard.recordSuccess(identity);
    } else {
      const failure = ocrGuard.recordFailure(identity);
      if (failure.locked) {
        console.warn(`⚠️ [OCR] ${identity} reached ${failure.failures} consecutive failures — automated OCR now LOCKED for 5 min.`);
      }
    }

    console.log(`🔍 [AUDIT] Comparison: Extracted ₱${extractedAmount} vs Required ₱${requiredAmount}`);
    console.log(`📊 [AUDIT] Result: amountMatch=${isAmountMatch}; dateMatch=${isDateMatch}; duplicate=${isDuplicate} -> Status: ${finalStatus}`);

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
        p_payment_status: finalStatus,
        p_ocr_metadata: {
          ...extractedData,
          requiredAmount,
          isAmountMatch,
          isDateMatch,
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
        console.error('⚠️ Atomic OCR persistence failed:', persistenceError.message);
        return res.status(500).json({
          success: false,
          error: 'OCR_PERSISTENCE_FAILED: Could not save detected data.'
        });
      }

      // Record in Master Audit Log
      try {
        await supabaseAdmin.from('audit_logs').insert({
          booking_id: bookingId,
          action_type: 'AI_VERIFICATION_COMPLETE',
          actor_name: 'AI_AUDITOR',
          actor_role: 'SYSTEM',
          details: `AI extraction complete. Reference: ${referenceNo || 'N/A'}. Amount: ₱${extractedAmount}. Amount match: ${isAmountMatch}. Date match: ${isDateMatch}. Duplicate: ${isDuplicate}.`
        });
      } catch (logErr) {
        console.warn('⚠️ Audit logging failed, but booking was updated.');
      }
    } else {
      console.log('ℹ️ [AI OCR] Booking is in PENDING state. Returning extraction results to frontend for submission.');
    }

    // ── STEP 2: AMOUNT / DATE / REFERENCE ──────────────────────────────────
    // Reached only after the name gate passed. An amount that does not match
    // (or a stale/duplicate receipt) blocks auto-approval but the booking is
    // still allowed to submit for manual admin review.
    const isValidReceipt = Boolean(isAmountMatch && isDateMatch && !isDuplicate && extractedData.isReceipt) && !qrVersionMismatch;
    const failureReason = isDuplicate
      ? 'FLAGGED_DETAILS_MISMATCH'
      : (qrVersionMismatch ? 'FLAGGED_QR_VERSION_MISMATCH'
        : (!isAmountMatch ? 'FLAGGED_AMOUNT_MISMATCH' : (!isDateMatch ? 'FLAGGED_DATE_MISMATCH' : null)));

    return res.json({
      valid: isValidReceipt,
      reason: isValidReceipt ? null : (failureReason || 'FLAGGED_DETAILS_MISMATCH'),
      status: isValidReceipt ? 'MATCH_SUCCESS' : (isDuplicate ? 'REJECTED_DUPLICATE' : 'FLAGGED_DETAILS_MISMATCH'),
      success: true,
      isNameMatch: true,
      isAmountMatch,
      isDateMatch,
      // Retain the old property until all existing frontend consumers have
      // migrated to isAmountMatch.
      isMatch: isAmountMatch,
      isDuplicate,
      persistedStatus: finalStatus,
      data: {
        ...extractedData,
        amount: extractedAmount,
        recipient: extractedData.recipient || 'N/A',
        expectedRecipientName
      }
    });

  } catch (error) {
    console.error('❌ [AI OCR Error]:', error);
    return res.status(500).json({
      success: false,
      error: `AI OCR failed: ${error.message}`
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
  const confirmationUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/password-confirmation?token=${encodeURIComponent(token)}`;
  const subject = purpose === 'RESET' ? 'Confirm your Speedway password reset' : 'Confirm your Speedway password change';
  const action = purpose === 'RESET' ? 'Reset Password' : 'Confirm Password Change';
  return send({
    to: email,
    subject,
    html: buildEmailShell({
      title: action,
      eyebrow: 'SPEEDWAY ACCOUNT SECURITY',
      bodyHtml: `<p style="margin:0 0 16px;color:#374151;line-height:1.7;">We received a request to ${purpose === 'RESET' ? 'reset' : 'change'} your Speedway password.</p><p style="margin:0 0 16px;color:#374151;line-height:1.7;">This confirmation link expires in <strong>15 minutes</strong> and can only be used once.</p><p style="margin:0;color:#6b7280;font-size:13px;">If you did not request this, ignore this email. Your current password remains unchanged.</p>`,
      ctaLink: confirmationUrl,
      ctaLabel: action,
      footerNote: 'Speedway Detail Studio | Account Security'
    })
  });
};

const sendPasswordSecurityAlert = async ({ email, purpose }) => send({
  to: email,
  subject: purpose === 'RESET' ? 'Your Speedway password was reset' : 'Your Speedway password was updated',
  html: buildEmailShell({
    title: purpose === 'RESET' ? 'Password Reset Complete' : 'Password Update Complete',
    eyebrow: 'SPEEDWAY ACCOUNT SECURITY',
    bodyHtml: '<p style="margin:0;color:#374151;line-height:1.7;">Your Speedway account password was successfully updated. If you did not make this change, contact support immediately.</p>',
    footerNote: 'Speedway Detail Studio | Account Security'
  })
});

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
  const { userId, oldEmail, newEmail } = req.body;
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
        subject: 'Speedway: Authorize Email Change',
        html: `
          <div style="font-family: sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #A91B18;">SPEEDWAY SECURITY</h2>
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

app.post('/api/auth/confirm-email-change', async (req, res) => {  const { userId, otp } = req.body;

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
app.get('/api/admin/profiles', async (req, res) => {
  console.log('📋 [ADMIN] Fetching all profiles...');
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .order('role', { ascending: true })
      .order('full_name');

    if (error) throw error;
    // Include defaultAdminId so frontend knows which account is protected
    return res.json({ success: true, data, defaultAdminId: DEFAULT_ADMIN_ID });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Section 1.1: Admin-driven account invitation ──────────────────────────────
// Generates a temporary password, creates the auth user + profile atomically
// (guarded by the create_invited_account RPC which blocks duplicates across BOTH
// auth.users and profiles), and delivers the credentials via the branded Resend
// relay so the email matches the dark-mode Speedway shell.
const generateTemporaryPassword = () => {
  // URL-safe, human-transcribable temporary password. Satisfies Supabase's
  // default minimum length and avoids ambiguous characters (0/O, 1/l).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return `${out}#7`;
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

    // 🛡️ SCENARIO 12 — IDENTITY CLASH: EXISTING CUSTOMER -> ROLE ELEVATION.
    //
    // The invitee already owns a CUSTOMER profile (e.g. they booked as a guest
    // two years ago). The old behaviour dead-ended here — the claim raised
    // EMAIL_ALREADY_EXISTS and the admin got a 409, so a loyal customer could
    // never become staff. We now ELEVATE the existing identity instead: the
    // profile row is UPDATEd in place (all FKs — bookings.customer_id,
    // audit_logs.actor_id, messages — stay intact, so no history is orphaned),
    // reactivated if soft-deleted, and the role change is written to the audit
    // trail. No ghost/duplicate account is created and no 500 is thrown.
    if (claim?.exists && claim?.can_elevate) {
      const { data: elevation, error: elevationError } = await supabaseAdmin.rpc('elevate_profile_role', {
        p_email: normalizedEmail,
        p_role: normalizedRole,
        p_first_name: safeFirst,
        p_last_name: safeLast,
        p_actor_id: actor.id || null
      });

      if (elevationError) {
        console.warn('🎟️ [INVITE] Role elevation RPC failed:', elevationError.message);
        return res.status(409).json({
          success: false,
          code: 'EMAIL_ALREADY_EXISTS',
          error: 'This email already belongs to an existing account. Elevate it from the Team module.'
        });
      }

      const elevated = elevation?.elevated === true;
      console.log(`🎟️ [INVITE] ${elevated ? `Elevated ${normalizedEmail} from ${elevation.old_role} to ${normalizedRole}` : `No elevation needed for ${normalizedEmail} (${elevation?.reason})`}.`);

      // The identity already signs in with their own credentials; we do NOT mint
      // a new temporary password or an auth user. A confirmation email is still
      // dispatched so the person knows their access level changed.
      try {
        const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
        await fetch(`${BACKEND_URL}/api/emails/status-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: normalizedEmail, type: 'ROLE_ELEVATED', role: normalizedRole })
        });
      } catch (mailErr) {
        console.warn('🎟️ [INVITE] Elevation notice email failed (non-fatal):', mailErr.message);
      }

      return res.json({
        success: true,
        elevated,
        alreadyAtRole: elevated === false && elevation?.reason === 'ALREADY_AT_ROLE',
        role: elevation?.role || normalizedRole,
        previousRole: elevation?.old_role || claim?.current_role || null,
        email: normalizedEmail,
        message: elevated
          ? `Existing account promoted to ${normalizedRole}. Their history and bookings were preserved.`
          : `This account already has ${normalizedRole} access.`
      });
    }

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
    const loginLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
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

    if (error) throw error;

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
                  <h2 style="color: #E61E2A;">Speedway System Announcement</h2>
                  <p style="font-size: 16px; color: #e5e7eb;">${message.trim()}</p>
                  <hr style="border: none; border-top: 1px solid #374151; margin: 20px 0;" />
                  <p style="font-size: 12px; color: #9ca3af;">This is an automated operational signal from Speedway Admin Command Center.</p>
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
  const { services = [], vehicles = [] } = req.body || {};
  try {
    if (Array.isArray(services) && services.length) {
      const names = services.map((s) => String(s?.name || s || '').trim()).filter(Boolean);
      if (names.length) {
        sendPreferenceGatedAnnouncement({
          preferenceKey: 'emailNewServices',
          subject: 'New services at Speedway ✨',
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
          <h2 style="color: #E61E2A;">Speedway has a new promo</h2>
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
  const { userId, newStatus } = req.body;
  console.log(`⏱️ [STAFF] Shift toggle request: userId=${userId}, newStatus=${newStatus}`);

  try {
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required.' });
    }

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
  const { userId, push_notifications_enabled } = req.body;
  console.log(`⚙️ [STAFF] Preference update request: userId=${userId}, pushEnabled=${push_notifications_enabled}`);

  try {
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required.' });
    }

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
  const { userId } = req.body;
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
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 🔄 REQ-CST-08: Transaction Reversal & Cancellation Loop
 * Updates booking and payment status for refund processing
 */
app.post('/api/bookings/cancel', async (req, res) => {
  const { bookingId, reason } = req.body;
  console.log(`🌀 [REVERSAL] CANCELLATION REQUESTED: ${bookingId}`);

  try {
    // 1. Update Booking Status
    const { error: bookingError } = await supabaseAdmin
      .from('bookings')
      .update({
        status: 'CANCELLED',
        staff_id: null,
        bay_id: null,
        cancellation_reason: reason,
        refund_status: 'QUEUED',
        updated_at: new Date().toISOString()
      })
      .eq('id', bookingId);

    if (bookingError) throw bookingError;

    // 2. Update Payment Status to REFUND_PENDING
    const { error: paymentError } = await supabaseAdmin
      .from('payments')
      .update({ status: 'REFUND_PENDING' })
      .eq('booking_id', bookingId);

    if (paymentError) {
      console.warn('⚠️ Payment record not found or update failed, continuing cancellation flow.');
    }

    // 3. Record in Audit Log
    await supabaseAdmin.from('audit_logs').insert({
      booking_id: bookingId,
      action_type: 'BOOKING_CANCELLED',
      actor_name: 'CUSTOMER',
      actor_role: 'USER',
      details: `Booking cancelled. Reason: ${reason}`
    });

    return res.json({ success: true, message: 'Booking cancelled and refund request queued.' });
  } catch (err) {
    console.error('❌ Cancellation Failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/verify-payment-ocr', async (req, res) => {
  const { receiptUrl } = req.body;
  try {
    if (!receiptUrl) throw new Error('Receipt URL is required');
    const receiptResponse = await fetch(receiptUrl);
    if (!receiptResponse.ok) throw new Error(`Receipt download failed with ${receiptResponse.status}`);

    const receiptBuffer = Buffer.from(await receiptResponse.arrayBuffer());
    const ocrResult = await processReceiptOCR(receiptBuffer, receiptResponse.headers.get('content-type') || 'image/jpeg');
    const extractedAmount = Number(ocrResult.amount || 0);
    const requiredAmount = Number(req.body.requiredAmount || 0);

    return res.json({
      success: true,
      // ±₱1.00 inclusive: `> 1` (not `>= 1`) so a ₱1.00 difference is a MATCH.
      // The previous `>= 1` flagged a ₱1.00 difference for review while `isMatch`
      // below called it a match — a contradictory pair of verdicts.
      status: requiredAmount > 0 && Math.abs(extractedAmount - requiredAmount) > 1 ? 'Flagged for Review' : 'Confirmed',
      isMatch: requiredAmount <= 0 || Math.abs(extractedAmount - requiredAmount) <= 1,
      data: {
        ...ocrResult,
        referenceNumber: ocrResult.referenceNumber,
        amount: extractedAmount
      }
    });
  } catch (err) {
    console.error('❌ Admin OCR Error:', err.message);
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
    const { data: existing } = await supabaseAdmin
      .from('vehicles')
      .select('id')
      .eq('owner_id', customerId)
      .eq('plate_number', plate)
      .maybeSingle();

    if (existing) {
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
 * Identifies bookings past start time and transitions to FLAGGED_NOSHOW.
 */
const NOSHOW_GRACE_MINUTES = 60;
const REMINDER_LEAD_MINUTES = 60;

const checkOverdueBookings = async () => {
  if (!supabaseAdmin) return;

  const now = new Date();
  const overdueThreshold = new Date(now.getTime() - NOSHOW_GRACE_MINUTES * 60000);
  const reminderThreshold = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60000);

  console.log(`🕒 [SYSTEM] RUNNING NO-SHOW AUDIT: ${now.toISOString()}`);

  try {
    // Case-tolerant: catches scheduled, confirmed, and reinstated pending_confirmation bookings that have passed their grace window.
    const { data: bookings, error } = await supabaseAdmin
      .from('bookings')
      .select('*, customer:profiles!bookings_customer_id_fkey(email, full_name), payments(id, amount, status)')
      .in('status', ['scheduled', 'confirmed', 'pending', 'PENDING', 'CONFIRMED', 'pending_confirmation']);

    if (error) throw error;

    for (const booking of (bookings || [])) {
      const status = normalizeStatus(booking.status);
      const startTime = new Date(booking.start_datetime);
      const graceWindowExpired = shouldRestoreGraceWindow(booking.status, booking.grace_period_until, now);

      if (status === 'pending_confirmation' && !graceWindowExpired) {
        continue;
      }

      // A. NO-SHOW FLAG (30 MINS) → FLAGGED_NOSHOW
      if (startTime < overdueThreshold || graceWindowExpired) {
        console.log(`⚠️ [FLAGGED_NOSHOW] Booking ${booking.id} flagged (30m+ No-Show or expired grace window)`);

        // Check if booking has verified payments for refund auto-flag
        const hasPaidPayments = (booking.payments || []).some(p => p.status === 'PAID');

        const updatePayload = {
          status: 'FLAGGED_NOSHOW',
          needs_attention: true
        };

        // REQ-CST-11: Auto-flag for refund if payment exists
        if (hasPaidPayments) {
          updatePayload.refund_status = 'PENDING';
          console.log(`💰 [REFUND] Booking ${booking.id} auto-flagged for refund (paid booking)`);
        }

        const { error: updateError } = await supabaseAdmin
          .from('bookings')
          .update({ ...updatePayload, staff_id: null, grace_period_until: null })
          .eq('id', booking.id);

        if (updateError) {
          console.error(`❌ [FLAGGED_NOSHOW] Update failed for ${booking.id}:`, updateError.message);
          continue; // Skip email if we couldn't update the status
        }

        await supabaseAdmin.from('audit_logs').insert({
          booking_id: booking.id,
          action_type: 'SYSTEM_FLAG_NOSHOW',
          actor_name: 'SYSTEM_AUDITOR',
          actor_role: 'SYSTEM',
          details: `Booking automatically flagged as No-Show (${NOSHOW_GRACE_MINUTES}m threshold).${hasPaidPayments ? ' Refund auto-queued.' : ''}`
        });

        // Send No-Show notification through the shared lifecycle email template.
        if (booking.customer?.email) {
          try {
            const projectUrl = process.env.SUPABASE_URL;
            const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
            const noShowResponse = await fetch(`${projectUrl}/functions/v1/send-status-email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
              body: JSON.stringify({
                bookingId: booking.id,
                newStatus: 'FLAGGED_NOSHOW',
                remarks: hasPaidPayments ? 'A refund request has been automatically filed because a payment was detected.' : ''
              })
            });
            if (!noShowResponse.ok) throw new Error(await noShowResponse.text());
          } catch (emailErr) {
            console.warn('📧 No-Show email failed:', emailErr.message);
          }
        }
      }

      // B. URGENT REMINDER (15 MINS) - REQ-SYS-02
      else if (booking.status?.toLowerCase() === 'confirmed' && startTime <= reminderThreshold && startTime > now && !booking.reminder_sent) {
        console.log(`📧 [REMINDER] Triggering one-hour reminder for ${booking.customer?.email}`);

        if (booking.customer?.email) {
          try {
            const projectUrl = process.env.SUPABASE_URL;
            const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
            const reminderResponse = await fetch(`${projectUrl}/functions/v1/send-status-email`, {
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
      }
    }
  } catch (err) {
    console.error('❌ No-Show Audit Error:', err.message);
  }
};

// Run the audit worker on a single backend instance in production. The query is
// status-scoped, so already processed bookings are not handled again.
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
  const { secret } = req.body;
  const DEBUG_SECRET = process.env.DEBUG_SECRET || 'speedway-dev-only';
  if (secret !== DEBUG_SECRET) {
    console.warn('🛑 [SECURITY] Unauthorized purge attempt blocked.');
    return res.status(403).json({ success: false, error: 'Forbidden: invalid secret' });
  }
  console.log('🧹 [ADMIN] PURGING ALL BOOKING DATA...');

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

app.post('/api/bookings/admin-cancel', async (req, res) => {
  const { bookingId, reason } = req.body;
  console.log(`🛑 [ADMIN] MANUAL CANCELLATION: ${bookingId} (Reason: ${reason})`);

  try {
    const { error: bookingError } = await supabaseAdmin
      .from('bookings')
      .update({
        status: 'CANCELLED',
        staff_id: null,
        bay_id: null,
        cancellation_reason: reason,
        cancellation_type: reason === 'No-Show' ? 'NO_SHOW' : 'ADMIN_MANUAL',
        needs_attention: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', bookingId);

    if (bookingError) throw bookingError;

    // 🛡️ Audit Trail
    await supabaseAdmin.from('audit_logs').insert({
      booking_id: bookingId,
      action_type: 'ADMIN_CANCEL_NOSHOW',
      actor_name: 'ADMIN',
      actor_role: 'ADMIN',
      details: `Manual cancellation performed by Admin. Reason: ${reason}`
    });

    return res.json({ success: true, message: 'Booking cancelled and audit log recorded.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bookings/undo-no-show', async (req, res) => {
  const { bookingId, actorName, adminId, pendingRefund } = req.body || {};

  if (!bookingId) {
    return res.status(400).json({ success: false, error: 'Booking ID is required.' });
  }

  try {
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .select('id, status, bay_id, customer_id, start_datetime, end_datetime, refund_status, staff_id, needs_attention, payment_status, grace_period_until')
      .eq('id', bookingId)
      .single();

    if (bookingError) throw bookingError;

    const normalizedBookingStatus = normalizeStatus(booking.status);
    if (!['flagged_noshow', 'no_show'].includes(normalizedBookingStatus)) {
      return res.status(409).json({ success: false, error: 'Booking is not currently flagged as no-show.' });
    }

    const { data: payments, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('id, status, payment_status, method, amount')
      .eq('booking_id', bookingId);

    if (paymentError) throw paymentError;

    const normalizedPaymentStatuses = (payments || []).map(payment => String(payment.payment_status || payment.status || '').trim().toLowerCase().replace(/[_\s-]+/g, '_'));
    const hasCompletedRefund = ['refunded', 'refund_processed', 'refundprocessed'].some(value => normalizedPaymentStatuses.includes(value))
      || ['refunded', 'refund_processed', 'refundprocessed'].includes(String(booking.payment_status || booking.refund_status || '').trim().toLowerCase().replace(/[_\s-]+/g, '_'))
      || (payments || []).some(payment => {
          const status = String(payment.status || '').trim().toLowerCase().replace(/[_\s-]+/g, '_');
          const method = String(payment.method || '').trim().toLowerCase();
          return ['refunded', 'refund_processed', 'refundprocessed'].includes(status)
            || (method === 'system_refund' && Number(payment.amount || 0) < 0);
        });

    if (hasCompletedRefund) {
      return res.status(400).json({
        success: false,
        error: 'Cannot undo no-show status: Payment refund has already been completed.'
      });
    }

    const refundPendingStates = ['refund_pending', 'flagged_for_refund', 'flaggedforrefund', 'refundpending'];
    const hasPendingRefund = Boolean(pendingRefund)
      || ['pending', 'queued', 'processing', 'email_pending'].some(state => String(booking.refund_status || '').toLowerCase().includes(state))
      || normalizedPaymentStatuses.some(status => refundPendingStates.includes(status))
      || (payments || []).some(payment => {
          const status = String(payment.status || '').trim().toLowerCase().replace(/[_\s-]+/g, '_');
          return ['refund_pending', 'flagged_for_refund', 'flaggedforrefund', 'refundpending'].includes(status)
            || ['refund_pending', 'flagged_for_refund', 'flaggedforrefund', 'refundpending'].includes(String(payment.payment_status || '').trim().toLowerCase().replace(/[_\s-]+/g, '_'));
        });

    const restorePayload = {
      status: 'pending_confirmation',
      staff_id: null,
      bay_id: booking.bay_id || null,
      needs_attention: false,
      refund_status: hasPendingRefund ? null : booking.refund_status,
      payment_status: hasPendingRefund ? 'approved' : booking.payment_status || 'pending',
      updated_at: new Date().toISOString(),
      reminder_sent: false,
      grace_period_until: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    };

    const { error: updateError } = await supabaseAdmin
      .from('bookings')
      .update(restorePayload)
      .eq('id', bookingId);

    if (updateError) throw updateError;

    if (hasPendingRefund) {
      const pendingPaymentIds = (payments || [])
        .filter(payment => {
          const status = String(payment.status || '').trim().toLowerCase().replace(/[_\s-]+/g, '_');
          const paymentStatus = String(payment.payment_status || '').trim().toLowerCase().replace(/[_\s-]+/g, '_');
          return ['refund_pending', 'flagged_for_refund', 'flaggedforrefund', 'refundpending', 'pending', 'queued', 'processing', 'email_pending'].includes(status)
            || ['refund_pending', 'flagged_for_refund', 'flaggedforrefund', 'refundpending'].includes(paymentStatus);
        })
        .map(payment => payment.id);

      if (pendingPaymentIds.length > 0) {
        const { error: paymentUpdateError } = await supabaseAdmin
          .from('payments')
          .update({
            status: 'PAID',
            payment_status: 'approved'
          })
          .in('id', pendingPaymentIds);

        if (paymentUpdateError) throw paymentUpdateError;
      }
    }

    const { error: vehicleError } = await supabaseAdmin
      .from('booking_vehicles')
      .update({ status: 'SCHEDULED', started_at: null, completed_at: null })
      .eq('booking_id', bookingId);

    if (vehicleError) {
      console.warn('Non-fatal vehicle-state restore warning:', vehicleError.message);
    }

    await supabaseAdmin.from('audit_logs').insert({
      booking_id: bookingId,
      action_type: 'UNDO_NO_SHOW',
      actor_name: actorName || 'ADMIN',
      actor_role: 'ADMIN',
      actor_id: adminId || null,
      details: `Admin reverted no-show for booking ${bookingId}. ${hasPendingRefund ? 'Pending refund request intercepted and cancelled.' : 'No refund request was pending.'}`
    });

    return res.json({
      success: true,
      message: 'No-show was reverted successfully and pending refund requests were intercepted.',
      bookingStatus: 'pending_confirmation',
      gracePeriodUntil: restorePayload.grace_period_until
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
    const minimumDownpayment = getRequiredDownpayment(servicePrice);
    const hasPayment = paymentAmount !== null && paymentAmount !== undefined;
    if (servicePrice >= 1000 && (!hasPayment || Number(paymentAmount) < minimumDownpayment || Number(paymentAmount) > servicePrice)) return res.status(409).json({ success: false, error: `Payment must be at least ${minimumDownpayment.toLocaleString()} and no more than the service price.` });
    if (hasPayment && (!Number.isFinite(Number(paymentAmount)) || Number(paymentAmount) <= 0 || Number(paymentAmount) > servicePrice)) return res.status(400).json({ success: false, error: 'Invalid service payment amount.' });

    const snapshot = {
      booking_vehicle_id: vehicleId,
      service_name: serviceName,
      price: servicePrice,
      duration_minutes: Number(durationMinutes || 60),
      vehicle_type: null,
      service_snapshot: {
        name: serviceName,
        price: servicePrice,
        duration_minutes: Number(durationMinutes || 60),
        source: 'admin_add_service'
      }
    };

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
    const serviceRow = {
      booking_vehicle_id: vehicleId,
      service_name: serviceName,
      price: servicePrice,
      duration_minutes: Number(durationMinutes || 60),
      service_snapshot: {
        name: serviceName,
        price: servicePrice,
        duration_minutes: Number(durationMinutes || 60),
        source: 'admin_add_service'
      }
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
      if (!rpcMissing) throw rpcError;

      // Fallback for a DB without the migration: keep the legacy writes but
      // RE-VERIFY the terminal guard immediately before each write so the race
      // window is minimized.
      console.warn('⚠️ [ADD SERVICE] mutate_booking_locked RPC missing — legacy locked fallback.');
      const { data: guardBooking } = await supabaseAdmin
        .from('bookings').select('status, total_amount, end_datetime').eq('id', bookingId).single();
      if (['released', 'completed', 'cancelled'].includes(String(guardBooking?.status || '').toLowerCase())) {
        return res.status(409).json({ success: false, error: 'This booking is closed and can no longer be modified.' });
      }
      try {
        const { error: serviceError } = await supabaseAdmin.from('booking_vehicle_services').insert(snapshot);
        if (serviceError) throw serviceError;
      } catch (serviceError) {
        const { error: fallbackError } = await supabaseAdmin.from('booking_vehicle_services').insert({
          booking_vehicle_id: vehicleId,
          service_name: serviceName,
          price: servicePrice
        });
        if (fallbackError) throw fallbackError;
      }
      const end = new Date(new Date(guardBooking.end_datetime).getTime() + Number(durationMinutes || 60) * 60000);
      const { error: bookingUpdateError } = await supabaseAdmin.from('bookings').update({ end_datetime: end.toISOString(), total_amount: Number(guardBooking.total_amount || 0) + servicePrice }).eq('id', bookingId);
      if (bookingUpdateError) throw bookingUpdateError;
      if (hasPayment) {
        const { error: paymentError } = await supabaseAdmin.from('payments').insert({ booking_id: bookingId, amount: Number(paymentAmount), method: paymentMethod, payment_type: paymentType, reference_number: paymentMethod === 'Digital' ? referenceNumber.trim() : null, status: 'PAID', verified_by: actor.user.id, verified_at: new Date().toISOString(), notes: `PAYMENT_${String(paymentMethod).toUpperCase()} | ADDED_SERVICE:${serviceName} | TYPE:${paymentType}` });
        if (paymentError) throw paymentError;
      }
      await supabaseAdmin.from('audit_logs').insert({ booking_id: bookingId, action_type: 'SERVICE_ADDED', actor_name: actor.user.email || actor.profile.full_name || 'Admin', actor_role: String(actor.profile.role).toUpperCase(), details: `Added ${serviceName}; ${hasPayment ? `recorded payment of ${paymentAmount}` : 'downpayment not required'}.` });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Add service failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/bookings/update-master-status', async (req, res) => {
  const { bookingId, status, reason = '' } = req.body;
  const actor = await getLifecycleActor(req);
  if (!actor) return res.status(403).json({ success: false, error: 'Authorized admin or staff account required.' });
  if (!bookingId || !status) return res.status(400).json({ success: false, error: 'Booking ID and status are required.' });

  try {
    const normalizedStatus = String(status).toLowerCase();
    const { data: booking, error: bookingError } = await supabaseAdmin.from('bookings').select('id, status, customer_id, total_amount, staff_id, start_datetime').eq('id', bookingId).single();
    if (bookingError) throw bookingError;
    const { data: vehicles, error: vehiclesError } = await supabaseAdmin.from('booking_vehicles').select('status').eq('booking_id', bookingId);
    if (vehiclesError) throw vehiclesError;
    const { data: payments, error: paymentsError } = await supabaseAdmin.from('payments').select('amount, status').eq('booking_id', bookingId);
    if (paymentsError) throw paymentsError;

    const currentStatus = String(booking.status || '').toLowerCase();
    const totalPaid = calculateNetPaid(payments || []);
    const requiredDownpayment = getRequiredDownpayment(booking.total_amount);
    const allCompleted = (vehicles || []).length > 0 && vehicles.every(vehicle => ['COMPLETED', 'CANCELLED'].includes(String(vehicle.status || '').toUpperCase()));

    if (normalizedStatus === 'confirmed') {
      if (!['scheduled', 'pending'].includes(currentStatus) || totalPaid < requiredDownpayment) {
        return res.status(409).json({ success: false, error: `Booking requires at least ${requiredDownpayment.toLocaleString()} in verified payment before confirmation.` });
      }
    } else if (normalizedStatus === 'in_progress') {
      const scheduledDate = new Date(booking.start_datetime);
      if (currentStatus !== 'confirmed' || !booking.staff_id || scheduledDate.toDateString() !== new Date().toDateString()) {
        return res.status(409).json({ success: false, error: 'Service can only start on the scheduled date after confirmation and staff assignment.' });
      }
    } else if (normalizedStatus === 'completed') {
      if (currentStatus !== 'in_progress' || !allCompleted || totalPaid < Number(booking.total_amount || 0)) {
        return res.status(409).json({ success: false, error: 'Booking can be completed only after every vehicle is finished and fully paid.' });
      }
    } else if (normalizedStatus === 'cancelled') {
      if (!reason.trim()) return res.status(400).json({ success: false, error: 'Cancellation reason is required.' });
      if (['completed', 'released', 'cancelled'].includes(currentStatus)) return res.status(409).json({ success: false, error: 'This booking can no longer be cancelled.' });
    } else {
      return res.status(400).json({ success: false, error: 'Unsupported master booking status.' });
    }

    const updatePayload = { status: normalizedStatus };
    if (normalizedStatus === 'cancelled') Object.assign(updatePayload, { cancellation_reason: reason.trim(), cancellation_type: 'ADMIN_MANUAL', refund_status: 'QUEUED', staff_id: null });
    const { error: updateError } = await supabaseAdmin.from('bookings').update(updatePayload).eq('id', bookingId);
    if (updateError) throw updateError;

    if (normalizedStatus === 'cancelled') {
      await supabaseAdmin.from('booking_vehicles').update({ status: 'CANCELLED' }).eq('booking_id', bookingId);
      await supabaseAdmin.from('payments').update({ status: 'REFUND_PENDING' }).eq('booking_id', bookingId).in('status', ['PAID', 'FOR_VERIFICATION']);
    }
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

    const [{ data: vehicles, error: vehiclesError }, { data: payments, error: paymentsError }] = await Promise.all([
      supabaseAdmin.from('booking_vehicles').select('status').eq('booking_id', bookingId),
      supabaseAdmin.from('payments').select('amount, status').eq('booking_id', bookingId)
    ]);
    if (vehiclesError) throw vehiclesError;
    if (paymentsError) throw paymentsError;

    const bookingStatus = booking.status?.toLowerCase();
    const allVehiclesFinished = (vehicles || []).length > 0
      && vehicles.every(vehicle => ['COMPLETED', 'CANCELLED'].includes(String(vehicle.status || '').toUpperCase()));
    const totalPaid = calculateNetPaid(payments || []);
    const isSettled = Number(booking.total_amount || 0) <= 0 || totalPaid >= Number(booking.total_amount || 0);
    if (bookingStatus !== 'completed' && !(allVehiclesFinished && isSettled)) {
      return res.status(409).json({ success: false, error: 'Only completed bookings can be released.' });
    }

    const { error: updateError } = await supabaseAdmin
      .from('bookings')
      .update({ status: 'RELEASED', staff_id: null, bay_id: null, updated_at: new Date().toISOString() })
      .eq('id', bookingId);
    if (updateError) throw updateError;

    await supabaseAdmin.from('audit_logs').insert({
      booking_id: bookingId,
      action_type: 'BOOKING_RELEASED',
      actor_name: 'ADMIN',
      actor_role: 'ADMIN',
      details: 'Booking released after customer vehicle pickup; staff allocation cleared.'
    });

    try {
      const projectUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      await fetch(`${projectUrl}/functions/v1/send-status-email`, {
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
app.post('/api/bookings/update-status', async (req, res) => {
  const { bookingId, unitId, newStatus, notes, actorName, actorRole } = req.body;

  if (!supabaseAdmin) return res.status(500).json({ success: false, error: 'Supabase Admin not initialized' });
  const actor = await getLifecycleActor(req);
  if (!actor) return res.status(403).json({ success: false, error: 'Authorized admin or staff account required.' });

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
    if (String(actor.profile.role).toUpperCase() === 'STAFF' && actor.profile.id !== masterBooking.staff_id) {
      return res.status(403).json({ success: false, error: 'Only the assigned technician may update this booking.' });
    }

    if (newStatus.toUpperCase() === 'IN_PROGRESS') {
      const scheduledDate = new Date(masterBooking.start_datetime);
      const nowDate = new Date();
      const isScheduledDate = scheduledDate.toDateString() === nowDate.toDateString();
      if (currentMaster !== 'confirmed' || !masterBooking.staff_id || !isScheduledDate) {
        return res.status(409).json({ success: false, error: 'Service can only start on the scheduled date after confirmation and staff assignment.' });
      }
    }

    if (newStatus.toUpperCase() === 'COMPLETED') {
      const { data: completionPayments, error: completionPaymentError } = await supabaseAdmin
        .from('payments')
        .select('amount, status')
        .eq('booking_id', bookingId);
      if (completionPaymentError) throw completionPaymentError;
      const totalPaidBeforeCompletion = (completionPayments || [])
        .filter(payment => payment.status === 'PAID')
        .reduce((sum, payment) => sum + Number(payment.amount), 0);
      if (Number(masterBooking.total_amount || 0) > 0 && totalPaidBeforeCompletion < Number(masterBooking.total_amount)) {
        return res.status(409).json({ success: false, error: 'Final payment is required before completing the service.' });
      }

      // 🛡️ Batch 5: Photo-proof gate. A unit cannot be finalized without at
      // least one post-service ('after') QA photo. The DB is the source of
      // truth; this server-side check means the rule cannot be bypassed by a
      // direct API call that skips the client UI.
      //
      // Admin override: an ADMIN actor may complete without a photo only when a
      // non-empty `overrideReason` is supplied. The override is written to the
      // audit log below so it is never silent.
      const { photoOverrideReason, overrideReason } = req.body;
      const overrideText = String(photoOverrideReason || overrideReason || '').trim();
      const isAdmin = String(actor.profile.role).toUpperCase() === 'ADMIN';

      const { count: afterPhotoCount, error: photoCountError } = await supabaseAdmin
        .from('service_photos')
        .select('id', { count: 'exact', head: true })
        .eq('booking_vehicle_id', unitId)
        .eq('phase', 'after');

      if (photoCountError) throw photoCountError;

      if (!afterPhotoCount || afterPhotoCount < 1) {
        if (!(isAdmin && overrideText)) {
          return res.status(409).json({
            success: false,
            error: 'At least 1 completion (after) photo is required before this unit can be marked complete.',
            code: 'PHOTO_PROOF_REQUIRED',
            adminOverrideSupported: true
          });
        }
        // Record the override on the request so the audit-log step can include it.
        req._photoOverride = { reason: overrideText, actorId: actor.profile.id };
      }
    }

    // 1. Update the specific vehicle unit
    const { error: unitError } = await supabaseAdmin
      .from('booking_vehicles')
      .update({
        status: newStatus.toUpperCase(),
        service_notes: notes || undefined,
        started_at: newStatus.toUpperCase() === 'IN_PROGRESS' ? timestamp : undefined,
        completed_at: newStatus.toUpperCase() === 'COMPLETED' ? timestamp : undefined
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
    const { data: payments, error: pError } = await supabaseAdmin
      .from('payments')
      .select('amount, status')
      .eq('booking_id', bookingId);

    const totalPaid = calculateNetPaid(payments || []);
    const balance = Math.max(0, (masterBooking.total_amount || 0) - totalPaid);
    const isFullySettled = (masterBooking.total_amount || 0) > 0 && balance === 0;

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
        await fetch(`${project_url}/functions/v1/send-status-email`, {
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
      actor_name: actorName || 'System',
      actor_role: actorRole || 'STAFF',
      details: `Unit ${unitId} updated to ${newStatus}. Master status: ${targetMasterStatus || 'unchanged'}`
    });

    // 🛡️ Batch 5: Record any COMPLETED-without-photo admin override as its own
    // audit entry so it is separately queryable and never silent.
    if (req._photoOverride) {
      await supabaseAdmin.from('audit_logs').insert({
        booking_id: bookingId,
        action_type: 'PHOTO_PROOF_OVERRIDE',
        actor_name: actorName || 'Admin',
        actor_role: actorRole || 'ADMIN',
        details: `Admin override: unit ${unitId} completed without a required after-photo. Reason: ${req._photoOverride.reason}`
      });
    }

    return res.json({
      success: true,
      masterStatus: targetMasterStatus || currentMaster,
      unitStatus: newStatus.toUpperCase()
    });

  } catch (err) {
    console.error('Propagation Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/debug/user/:email', async (req, res) => {
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

app.get('/api/debug/list-users', async (req, res) => {
  const DEBUG_SECRET = process.env.DEBUG_SECRET || 'speedway-dev-only';
  if (req.query.secret !== DEBUG_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  try {
    const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers();
    if (error) throw error;

    // Return last 10 users
    const lastUsers = users
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10)
      .map(u => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        confirmed_at: u.confirmed_at,
        role: u.user_metadata?.role
      }));

    return res.json({ success: true, users: lastUsers });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


app.post('/api/debug/fix-account', async (req, res) => {
  const { email, secret } = req.body;
  const DEBUG_SECRET = process.env.DEBUG_SECRET || 'speedway-dev-only';
  if (secret !== DEBUG_SECRET) {
    console.warn(`🛑 [SECURITY] Unauthorized fix-account attempt for: ${email}`);
    return res.status(403).json({ success: false, error: 'Forbidden: invalid secret' });
  }
  try {
    const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) throw listError;

    const user = users.find(u => u.email === email);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: 'Password123!',
      email_confirm: true
    });

    if (updateError) throw updateError;

    return res.json({ success: true, message: `Password for ${email} reset to 'Password123!' and email confirmed.` });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// NOTE: the canonical shift-toggle handler is defined earlier in this file
// (POST /api/staff/toggle-shift, near the other /api/staff routes). A duplicate
// definition previously lived here; Express only ever executes the FIRST match,
// so this second copy was dead code — and it was inconsistent (it wrote to a
// staff_shifts table the primary handler does not, and it never set
// clock_in_timestamp). Removed to keep a single source of truth.

// 🔒 Schedule Block Management Endpoints (Bypassing RLS 403 Forbidden)
app.post('/api/admin/blocked-slots', async (req, res) => {
  const { block_date, dates, start_date, end_date, start_time, end_time, reason } = req.body;
  // Attribute the block to the acting admin so a later "who closed this day?"
  // question is answerable straight from the row (previously created_by was
  // always null, which made the source of an unexpected block untraceable).
  const createdBy = req.body.created_by || req.body.actor_id || null;
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
app.get('/api/health', (req, res) => {
  return res.status(200).json({
    success: true,
    status: 'ok',
    service: 'speedway-backend',
    supabaseReady: Boolean(supabaseAdmin),
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
    const { loadScheduleContext, countStaffOnDuty } = require('./services/scheduleValidation');
    const { getBookableSlots } = require('../frontend/src/domain/schedule/rules.js');
    const durationMinutes = Math.max(1, Number(req.query.durationMinutes) || 60);
    const requestedBays = Math.max(1, Number(req.query.requestedBays) || 1);
    const { config, blocks, bookings } = await loadScheduleContext(supabaseAdmin, date, {
      excludeBookingId: req.query.excludeBookingId,
      durationMinutes,
    });
    const staffOnDuty = await countStaffOnDuty(supabaseAdmin);
    // skipLeadTime=1 -> admin/desk view: show imminent slots the customer-facing
    // "minimum advance notice" would otherwise hide.
    const skipLeadTime = String(req.query.skipLeadTime || '') === '1' || req.query.skipLeadTime === 'true';
    const slots = getBookableSlots(date, config, bookings, {
      blocks, durationMinutes, requestedBays, staffOnDuty, skipLeadTime,
    });
    return res.json({ success: true, date, slots });
  } catch (err) {
    console.error('❌ Slot Enumeration Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Allow cross-module use of the shared validator from booking creation paths.
app.locals.validateBookingRequest = validateBookingRequest;

app.listen(PORT, () => {
  console.log('\n' + '*'.repeat(50));
  console.log(`🚀 SPEEDWAY SHADOW BACKEND: http://localhost:${PORT}`);
  console.log('*'.repeat(50) + '\n');
}).on('error', (err) => {
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


