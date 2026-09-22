/**
 * Step 7.5 — Suite 1 (browser E2E): emergency lockout + theme persistence.
 * Asserts the REAL AuthContext lockout contract: 5 failed attempts -> lock.
 * Run against the production preview (fast, warm).
 */
const BASE = process.env.AUDIT_BASE || 'http://localhost:4180';

export default async function run(page, ui) {
  const out = { attempts: [], lockoutObserved: false, theme: {} };

  await page.setViewportSize({ width: 390, height: 800 });

  // Fresh state.
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    Object.keys(localStorage).forEach((k) => { if (k.startsWith('sb-') || k.startsWith('speedway-login')) localStorage.removeItem(k); });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const emailSel = 'input[type="email"]';
  const passSel = 'input[type="password"]';
  const badEmail = 'lockout-probe@speedway.test';

  for (let i = 1; i <= 6; i++) {
    const email = page.locator(emailSel).first();
    const pass = page.locator(passSel).first();
    if (!(await pass.count())) {
      out.attempts.push({ attempt: i, note: 'password field gone (already locked/redirected)' });
      break;
    }
    await email.fill(badEmail).catch(() => { });
    await pass.fill('definitely-wrong-password').catch(() => { });
    await page.getByRole('button', { name: /login|sign in/i }).first().click().catch(() => { });
    await page.waitForTimeout(1800);

    // Read any inline error text the form renders.
    const body = await page.evaluate(() => document.body.innerText);
    const lockMatch = body.match(/temporarily locked|Account locked for 20 minutes/i);
    const failMatch = body.match(/Attempt (\d) of 5/i);
    out.attempts.push({
      attempt: i,
      attemptCounterSeen: failMatch ? failMatch[1] : null,
      locked: Boolean(lockMatch),
      errSnippet: (body.match(/Invalid login credentials[^\n]*/i) || lockMatch || [''])[0].slice(0, 80),
    });
    if (lockMatch) { out.lockoutObserved = true; break; }
  }

  // Theme persistence across reloads.
  for (const t of ['light', 'dark']) {
    await page.evaluate((theme) => localStorage.setItem('speedway-theme', theme), t);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    out.theme[t] = await page.evaluate(() => document.documentElement.dataset.theme);
  }

  return out;
}