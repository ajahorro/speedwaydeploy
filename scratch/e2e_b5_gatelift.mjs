// Batch 5 gate-lift probe: with an 'after' photo already present, the completion
// button must be ENABLED (the hard block lifts). This proves the gate is a real
// condition, not a permanently-disabled button.
export default async function run(page /*, ui */) {
  const out = { checks: [] };
  const check = (label, ok, detail = '') => out.checks.push({ label, ok, detail });

  await page.context().clearCookies();
  const base = page.url().replace(/\/[^/]*$/, '/');
  await page.goto(base + 'login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
  await page.goto(base + 'login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.locator('input[type="email"], input[name="email"]').first().fill('staff1@speedway.com');
  const passInput = page.locator('input[type="password"], input[name="password"]').first();
  for (const pass of ['staff123', 'staff1234']) {
    await passInput.fill(pass);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(2500);
    if (!page.url().includes('/login')) break;
  }
  check('staff login', !page.url().includes('/login'), page.url());

  try {
    await page.waitForFunction(() => /VIOS E2E/i.test(document.body.innerText), null, { timeout: 25000 });
  } catch { /* report below */ }
  await page.waitForTimeout(1500);

  // Start the task (PENDING -> IN_PROGRESS).
  const startBtn = page.getByRole('button', { name: /start service/i }).first();
  if (await startBtn.count()) {
    await startBtn.click().catch(() => { });
    await page.waitForTimeout(1800);
    const confirm = page.getByRole('button', { name: /start( without intake photo)?$/i }).last();
    if (await confirm.count()) await confirm.click().catch(() => { });
    await page.waitForTimeout(4500);
  }

  const text = await page.evaluate(() => document.body.innerText);
  const upper = text.toUpperCase();
  check('task is IN_PROGRESS', upper.includes('IN_PROGRESS'));

  // The photo count for the after-uploader should now be >= 1 and the completion
  // button should be ENABLED (gate lifted).
  const finish = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /mark as finished|override & finish/i.test(b.textContent || ''));
    if (!btn) return null;
    return { text: btn.textContent.trim(), disabled: btn.disabled, title: btn.getAttribute('title') || '' };
  });
  check('completion button present', Boolean(finish), finish ? finish.text : 'not found');
  if (finish) {
    check('completion button ENABLED once an after photo exists', finish.disabled === false,
      `disabled=${finish.disabled}; title="${finish.title}"`);
  }
  check('no "completion photo required" badge', !/completion photo required/i.test(text));

  out.summary = { passed: out.checks.filter(c => c.ok).length, failed: out.checks.filter(c => !c.ok).length };
  return out;
}
