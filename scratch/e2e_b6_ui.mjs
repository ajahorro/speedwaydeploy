// Batch 6 interactive sweep — Batch 6 schedule-rules surfaces.
//
// Two modes:
//   (a) full app  — default. Logs in as admin, opens BusinessHub -> Schedule Rules.
//       node <skill>/browser.mjs http://localhost:4173/ --script scratch/e2e_b6_ui.mjs
//   (b) preview   — B6_PREVIEW=1. The target page already mounts BusinessHub on
//       the Schedule Rules tab (no auth), proving the assertions against real DOM
//       without live credentials.
//       B6_PREVIEW=1 node <skill>/browser.mjs <preview-url> --script scratch/e2e_b6_ui.mjs
//
// It verifies the Schedule Rules tab, its four controls, the triple-state
// smart-save pattern, and that the validate-slot endpoint rejects a past date.
const env = (k, fallback) => process.env[k] || fallback;

export default async function run(page) {
  const out = { checks: [] };
  const check = (label, ok, detail = '') => out.checks.push({ label, ok, detail });

  const adminEmail = env('E2E_ADMIN_EMAIL', 'testadmin961@gmail.com');
  const adminPass = env('E2E_ADMIN_PASS', 'admin1234');
  const previewMode = env('B6_PREVIEW', '') === '1';
  const base = page.url().replace(/\/[^/]*$/, '/');

  if (!previewMode) {
    // ── Admin login ──────────────────────────
    await page.context().clearCookies();
    await page.goto(base + 'login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
    await page.goto(base + 'login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    await page.locator('input[type="email"], input[name="email"]').first().fill(adminEmail);
    const passInput = page.locator('input[type="password"], input[name="password"]').first();
    for (const pass of [adminPass, adminPass.replace(/4$/, ''), adminPass + '4']) {
      await passInput.fill(pass);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForTimeout(2500);
      if (!page.url().includes('/login')) break;
    }
    check('admin login', !page.url().includes('/login'), page.url());
    if (page.url().includes('/login')) {
      out.summary = summarize(out.checks);
      return out;
    }

    // ── Open BusinessHub -> Schedule Rules ────────────────────
    await page.goto(base + 'admin?tab=schedule', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
    if (!/SCHEDULE RULES/i.test(await page.evaluate(() => document.body.innerText))) {
      await page.goto(base + 'admin/business-hub?tab=schedule', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2500);
    }
  } else {
    // Preview page already shows BusinessHub on the Schedule Rules tab.
    await page.waitForTimeout(900);
  }

  const text = await page.evaluate(() => document.body.innerText);
  out.bodySnippet = text.slice(0, 400);

  // ── Panel presence ──────────────────────────
  check('Schedule Rules tab reachable', /SCHEDULE RULES/i.test(text), text.slice(0, 120));
  check('lead-time control present', /LEAD TIME/i.test(text));
  check('advance-window control present', /ADVANCE/i.test(text));
  check('closed-days toggles present', /\bSUN\b/.test(text) && /\bSAT\b/.test(text));
  check('capacity toggle present', /CAPACITY/i.test(text));

  // ── Smart-save triple-state ─────────────────
  const readSave = async () => page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /SAVE SCHEDULE RULES/i.test(x.innerText || ''));
    if (!b) return null;
    return { disabled: b.disabled, bg: getComputedStyle(b).backgroundColor };
  });

  const pristine = await readSave();
  check('smart-save button present', Boolean(pristine), pristine ? JSON.stringify(pristine) : 'not found');
  if (pristine) check('pristine -> save disabled', pristine.disabled === true, JSON.stringify(pristine));

  const leadInput = page.locator('input[type="number"]').first();
  if (await leadInput.count()) {
    const original = await leadInput.inputValue();

    await leadInput.fill('90');
    await page.waitForTimeout(400);
    const modified = await readSave();
    check('modified+valid -> save enabled', modified && modified.disabled === false, JSON.stringify(modified));
    check('modified -> save button brand red', modified && /230,\s*30,\s*42/.test(modified.bg), modified?.bg);

    await leadInput.fill('99999');
    await page.waitForTimeout(400);
    const invalid = await readSave();
    check('modified+invalid -> save disabled again', invalid && invalid.disabled === true, JSON.stringify(invalid));

    // Restore the original so we never persist a test value.
    await leadInput.fill(original);
    await page.waitForTimeout(200);
  } else {
    check('lead-time number input discoverable', false, 'no input[type=number] found');
  }

  // ── Endpoint reachability probe (full-app mode only; needs the backend) ─────
  if (!previewMode) {
    const probe = await page.evaluate(async (origin) => {
      try {
        const res = await fetch(`${origin}api/bookings/validate-slot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: '2000-01-01', time: '11:00' }),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      } catch (e) { return { error: e.message }; }
    }, base);
    check('validate-slot rejects a past date',
      probe.status === 400 && probe.body?.code === 'PAST_DATE',
      JSON.stringify(probe).slice(0, 160));
  }

  out.summary = summarize(out.checks);
  return out;
}

function summarize(checks) {
  return {
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
  };
}