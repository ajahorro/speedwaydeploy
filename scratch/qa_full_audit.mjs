/**
 * Step 7.4 — FULL route audit with DETERMINISTIC auth.
 *
 * Instead of driving the login form (slow + flaky on the dev server), this
 * obtains a supabase-js v2 session via the auth REST API and injects it into
 * localStorage under the exact key supabase-js reads. Navigation then lands
 * directly on the guarded route.
 *
 * Env:
 *   AUDIT_BASE  base url (default http://localhost:5180 preview)
 *   GROUP       public|admin|staff|customer
 *   SLICE       "start:end" optional route slice
 *   ONLY_THEME  dark|light optional
 */
import fs from 'node:fs';

const BASE = process.env.AUDIT_BASE || 'http://localhost:4180';
const GROUP = process.env.GROUP || 'public';
const ONLY_THEME = process.env.ONLY_THEME || null;
const SLICE = process.env.SLICE || null;

const envTxt = fs.readFileSync(new URL('../frontend/.env', import.meta.url), 'utf8');
const pick = (k) => envTxt.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const SB_URL = pick('VITE_SUPABASE_URL');
const SB_ANON = pick('VITE_SUPABASE_ANON_KEY');
const SB_REF = SB_URL.replace('https://', '').split('.')[0];
const STORAGE_KEY = `sb-${SB_REF}-auth-token`;

const ROUTES = {
  public: ['/', '/login', '/accept-invite', '/password-confirmation'],
  admin: ['/admin', '/admin/business', '/admin/walk-in', '/admin/bookings', '/admin/bookings/e5b3cf4b-8f96-4a95-8393-78d33a83f98a', '/admin/schedule', '/admin/payments', '/admin/refunds', '/admin/analytics', '/admin/finance', '/admin/audit-logs', '/admin/accounts', '/admin/users', '/admin/settings', '/admin/notifications', '/admin/profile'],
  staff: ['/staff', '/staff/tasks', '/staff/history', '/staff/job/e5b3cf4b-8f96-4a95-8393-78d33a83f98a', '/staff/profile', '/staff/notifications', '/staff/settings'],
  customer: ['/customer', '/customer/book', '/customer/bookings', '/customer/bookings/e5b3cf4b-8f96-4a95-8393-78d33a83f98a', '/customer/billing', '/customer/garage', '/customer/notifications', '/customer/settings', '/customer/profile', '/customer/receipt/e5b3cf4b-8f96-4a95-8393-78d33a83f98a'],
};

const CRED = {
  admin: { email: 'testadmin961@gmail.com', password: 'admin1234' },
  staff: { email: 'staff1@speedway.com', password: 'staff1234' },
  customer: { email: 'jayneahorro@gmail.com', password: 'jayne1234' },
};

async function getSession(role) {
  const c = CRED[role];
  const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: c.email, password: c.password }),
  });
  if (!r.ok) throw new Error(`auth failed for ${role}: ${r.status} ${await r.text()}`);
  return r.json(); // { access_token, refresh_token, user, expires_in, ... }
}

const PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const docScrollW = document.documentElement.scrollWidth;
  const bodyScrollW = document.body.scrollWidth;
  const overflow = Math.max(docScrollW, bodyScrollW) > vw + 1;
  const offenders = [];
  if (overflow) {
    const isAllowed = (el) => { let p = el; while (p && p !== document.body) { const cs = getComputedStyle(p); if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true; p = p.parentElement; } return false; };
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > vw + 1) { if (isAllowed(el)) continue; offenders.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 60), right: Math.round(r.right), w: Math.round(r.width), text: (el.innerText || '').trim().slice(0, 40) }); if (offenders.length >= 8) break; }
    }
  }
  return { vw, docScrollW, bodyScrollW, overflow, offenders };
})()`;

export default async function run(page, ui) {
  await page.setViewportSize({ width: 375, height: 740 });
  const out = { group: GROUP, base: BASE, results: [], auth: null };

  if (GROUP !== 'public') {
    const session = await getSession(GROUP);
    out.auth = { ok: true, expires_in: session.expires_in };
    // Inject the exact shape supabase-js v2 expects, then reload so
    // AuthContext picks it up before any guarded route mounts.
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(([key, s]) => {
      localStorage.setItem(key, JSON.stringify({
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
        expires_in: s.expires_in || 3600,
        token_type: 'bearer',
        user: s.user,
      }));
    }, [STORAGE_KEY, session]);
    await page.waitForTimeout(800);
  }

  let routes = ROUTES[GROUP];
  if (SLICE) { const [s, e] = SLICE.split(':').map(Number); routes = routes.slice(s, e); }
  const themes = ONLY_THEME ? [ONLY_THEME] : ['dark', 'light'];

  for (const route of routes) {
    for (const theme of themes) {
      await page.evaluate((t) => localStorage.setItem('speedway-theme', t), theme);
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
      // Wait for content (not a fixed delay): an expected landmark per area.
      await page.waitForTimeout(2200);
      const r = await page.evaluate(PROBE);
      out.results.push({ route, theme, finalUrl: page.url(), vw: r.vw, docScrollW: r.docScrollW, bodyScrollW: r.bodyScrollW, overflow: r.overflow, offenders: r.offenders });
    }
  }

  out.failures = out.results.filter((x) => x.overflow);
  return out;
}