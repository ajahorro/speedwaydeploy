/**
 * Step 7.5 — Suites 2/4/5 (browser E2E) + Task B presence verification.
 * Injects sessions, exercises real surfaces, and PROVES which Task B features
 * are absent (evidence, not assertion).
 */
import fs from 'node:fs';

const BASE = process.env.AUDIT_BASE || 'http://localhost:4180';
const envTxt = fs.readFileSync(new URL('../frontend/.env', import.meta.url), 'utf8');
const pick = (k) => envTxt.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const SB = pick('VITE_SUPABASE_URL');
const ANON = pick('VITE_SUPABASE_ANON_KEY');
const KEY = `sb-${SB.replace('https://', '').split('.')[0]}-auth-token`;
const auth = async (e, p) => (await (await fetch(`${SB}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: p }),
})).json());

const loginAs = async (page, email, pw) => {
  const s = await auth(email, pw);
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(([k, sess]) => localStorage.setItem(k, JSON.stringify({
    access_token: sess.access_token, refresh_token: sess.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (sess.expires_in || 3600),
    expires_in: sess.expires_in || 3600, token_type: 'bearer', user: sess.user,
  })), [KEY, s]);
  return s;
};

export default async function run(page, ui) {
  await page.setViewportSize({ width: 390, height: 800 });
  const out = {};

  // ── Suite 5: lifecycle surfaces reachable per role ──────────────────────
  await loginAs(page, 'testadmin961@gmail.com', 'admin1234');
  const adminRoutes = ['/admin', '/admin/bookings', '/admin/walk-in', '/admin/refunds', '/admin/schedule', '/admin/audit-logs'];
  out.adminLifecycle = {};
  for (const r of adminRoutes) {
    await page.goto(BASE + r, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    out.adminLifecycle[r] = { url: page.url(), chars: await page.evaluate(() => document.body.innerText.length) };
  }

  // ── Suite 4 / Task B: Business Hub field-guard + QR/OTP presence ─────────
  await page.goto(BASE + '/admin/business', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  out.businessHub = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return {
      chars: t.length,
      hasQrAccountName: t.includes('qr account name'),
      hasQrAccountNumber: t.includes('qr account number'),
      hasFallbackReceiverName: t.includes('fallback receiver name'),
      hasFallbackReceiverNumber: t.includes('fallback receiver number'),
      hasOtp: /\botp\b|one[- ]time (code|password)|6[- ]digit/.test(t),
      hasViewChanges: t.includes('view changes'),
      hasSaveButton: /save|saving|update/.test(t),
    };
  });

  // ── Suite 2: OCR / payment surface (customer booking review) ────────────
  await loginAs(page, 'jayneahorro@gmail.com', 'jayne1234');
  await page.goto(BASE + '/customer/book', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  out.bookingWizard = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return {
      chars: t.length,
      hasConfidence: /confidence|% sure|match score/.test(t),
      hasManualQueue: /manual (review|queue)|pending admin queue/.test(t),
      hasVehicleFields: /vehicle|plate/.test(t),
    };
  });

  // ── Audit log surface: does it expose a [View Changes] diff modal? ───────
  await loginAs(page, 'testadmin961@gmail.com', 'admin1234');
  await page.goto(BASE + '/admin/audit-logs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  out.auditLogs = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return {
      chars: t.length,
      hasViewChanges: t.includes('view changes'),
      hasOldNew: /old value|new value|before|after/.test(t),
      hasRows: document.querySelectorAll('tr, [class*="row"], [class*="log"]').length,
    };
  });

  return out;
}