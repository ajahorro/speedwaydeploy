// Batch 5 interactive staff sweep.
// Logs in as staff1, finds the seeded task card, and verifies:
//   - both phased uploaders render (Intake Before / Completion After)
//   - the completion button is HARD-BLOCKED while no after photo exists
//   - the intake soft-warning semantics are present on the Start path
//   - "Add Photos" controls are wired (file inputs present)
// Returns a structured report. It drives the Start flow to reach IN_PROGRESS.
export default async function run(page /*, ui */) {
  const out = { checks: [] };
  const check = (label, ok, detail = '') => out.checks.push({ label, ok, detail });

  // Clean session + staff login.
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

  // Wait deterministically for the staff dashboard + the seeded task card.
  try {
    await page.waitForFunction(
      () => /VIOS E2E/i.test(document.body.innerText) || /DAILY TASK QUEUE/i.test(document.body.innerText),
      null,
      { timeout: 25000 }
    );
  } catch { /* fall through; assertions below will report */ }
  await page.waitForTimeout(1500);
  let text = await page.evaluate(() => document.body.innerText);

  const hasSeedTask = /VIOS E2E/i.test(text);
  check('seeded task card rendered on staff dashboard', hasSeedTask,
    hasSeedTask ? 'found "Vios E2E"' : 'not found (queue may be empty)');

  check('intake soft-warning surface present (Start path)', /START SERVICE/i.test(text));
  check('intake warning text surfaced', /intake photo/i.test(text) || /recommended/i.test(text));

  // Drive the START flow to reach IN_PROGRESS where the completion gate lives.
  const startBtn = page.getByRole('button', { name: /start service/i }).first();
  const startExists = await startBtn.count();
  check('Start Service button present (SCHEDULED task)', startExists > 0);
  if (startExists) {
    await startBtn.click().catch(() => {});
    await page.waitForTimeout(1800);
    // The confirmation modal renders a button; its label is either
    // "Start Service" (has intake photo) or "Start Without Intake Photo".
    const confirm = page.getByRole('button', { name: /start( without intake photo)?$/i }).last();
    if (await confirm.count()) {
      await confirm.click().catch(() => {});
    } else {
      // Fallback: click the primary action in the dialog.
      const dlgBtn = page.locator('[role="dialog"] button').last();
      await dlgBtn.click().catch(() => {});
    }
    await page.waitForTimeout(4000);
  }
  text = await page.evaluate(() => document.body.innerText);
  const upper = text.toUpperCase();

  const hasIntakeHeading = upper.includes('INTAKE PHOTOS (BEFORE)');
  const hasCompletionHeading = upper.includes('COMPLETION PHOTOS (AFTER)');
  check('Intake Photos (Before) uploader rendered', hasIntakeHeading);
  check('Completion Photos (After) uploader rendered', hasCompletionHeading);
  check('task advanced to IN_PROGRESS', upper.includes('IN_PROGRESS'));

  const addPhotoCount = await page.evaluate(() =>
    [...document.querySelectorAll('label')].filter(l => /add photos/i.test(l.textContent || '')).length
  );
  check('Add Photos controls present', addPhotoCount >= 1, `${addPhotoCount} control(s)`);

  // The completion button: with no after photo it must be DISABLED (hard block).
  const finish = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /mark as finished|override & finish/i.test(b.textContent || ''));
    if (!btn) return null;
    return { text: btn.textContent.trim(), disabled: btn.disabled, title: btn.getAttribute('title') || '' };
  });
  check('completion button present', Boolean(finish), finish ? finish.text : 'not found');
  if (finish) {
    check('completion HARD-BLOCKED without an after photo', finish.disabled === true,
      `disabled=${finish.disabled}; title="${finish.title}"`);
  }
  check('completion-required badge shown', /completion photo required/i.test(text));

  out.bodySnippet = text.slice(0, 600);
  out.summary = { passed: out.checks.filter(c => c.ok).length, failed: out.checks.filter(c => !c.ok).length };
  return out;
}
