// Focused Batch 5 UI probe: log in as STAFF and confirm the new photo-proof
// surfaces render on the staff dashboard, and that the completion gate state
// is wired. Reports the DOM text so we can see what actually rendered.
//
//   node <skill>/browser.mjs http://localhost:5173/ --script scratch/e2e_b5_ui.mjs
export default async function run(page /*, ui*/) {
  const out = { steps: [] };

  // Clean session, then log in as staff.
  await page.context().clearCookies();
  await page.goto(page.url().replace(/\/[^/]*$/, '/') + 'login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
  await page.goto(page.url().replace(/\/[^/]*$/, '/') + 'login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passInput = page.locator('input[type="password"], input[name="password"]').first();
  await emailInput.fill('staff1@speedway.com');
  for (const pass of ['staff123', 'staff1234']) {
    await passInput.fill(pass);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(2500);
    if (!page.url().includes('/login')) break;
  }
  out.steps.push({ step: 'staff login', url: page.url() });

  // Let the dashboard settle and load tasks.
  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body.innerText);
  out.hasIntakeHeading = bodyText.includes('Intake Photos (Before)');
  out.hasCompletionHeading = bodyText.includes('Completion Photos (After)');
  out.hasEvidenceRule = bodyText.includes('At least one completion photo is required');
  out.hasAddPhotos = bodyText.includes('Add Photos');

  // Count the uploader sections present.
  out.uploaderSections = await page.evaluate(() =>
    document.querySelectorAll('section[aria-label*="Photos"]').length
  );

  // Is the "MARK AS FINISHED" gate logic reachable? (only when a task is IN_PROGRESS)
  out.hasFinishButton = bodyText.includes('MARK AS FINISHED') || bodyText.includes('OVERRIDE & FINISH');
  out.hasStartButton = bodyText.includes('START SERVICE');

  out.bodyHead = bodyText.slice(0, 400);
  return out;
}
