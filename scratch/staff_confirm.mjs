export default async function run(page, ui) {
  const log = [];
  const consoleErrors = [];

  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"], input[name="email"]').first().fill('staff1@speedway.com');
  await page.locator('input[type="password"]').first().fill('staff1234');
  await page.getByRole('button', { name: /sign in|log in|login/i }).first().click();
  await page.waitForTimeout(4000);
  log.push('logged in: ' + page.url());

  await page.goto('http://localhost:5173/staff/duty', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // Capture network calls to the backend during the clock-out
  const netCalls = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('/api/staff/toggle-shift') || u.includes('profiles')) {
      let body = '';
      try { body = (await r.text()).slice(0, 400); } catch { }
      netCalls.push(`${r.status()} ${r.request().method()} ${u} :: ${body}`);
    }
  });
  page.on('requestfailed', (r) => {
    netCalls.push(`FAILED ${r.method()} ${r.url()} :: ${r.failure()?.errorText}`);
  });

  const duty = await ui.snapshot();
  const co = duty.match(/@(e\d+) button "CLOCK OUT"/i);
  if (!co) return { log, error: 'no clock out button', duty };
  await ui.click(co[1]);
  await page.waitForTimeout(1200);

  // Click the confirm button inside the modal
  const confirmMatch = await ui.snapshot();
  log.push('--- post-open snapshot ---');
  log.push(confirmMatch);
  const confirm = confirmMatch.match(/@(e\d+) button "CLOCK OUT"/i);
  const confirmBtn = page.locator('.app-modal-actions button').last();
  await confirmBtn.click();
  await page.waitForTimeout(4000);
  log.push('clicked confirm clock out');

  const after = await page.evaluate(() => ({
    url: location.href,
    modalPresent: !!document.querySelector('.app-modal'),
    bodySnippet: document.body.innerText.slice(0, 600)
  }));
  log.push('--- after confirm ---');
  log.push(JSON.stringify(after));
  return { log, netCalls };
}
