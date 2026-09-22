// Batch 5 admin gallery sweep.
// Reads the seed handoff, logs in as admin, opens the seeded booking detail,
// clicks "View Evidence", and confirms the before/after drawer opens.
import fs from 'node:fs';

export default async function run(page /*, ui */) {
  const HANDOFF = 'C:/Users/ajaho/Downloads/speedway_thesis/scratch/b5_seed_handoff.json';
  const handoff = JSON.parse(fs.readFileSync(HANDOFF, 'utf8'));
  const out = { checks: [], bookingId: handoff.bookingId };
  const check = (label, ok, detail = '') => out.checks.push({ label, ok, detail });

  await page.context().clearCookies();
  const base = page.url().replace(/\/[^/]*$/, '/');
  await page.goto(base + 'login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
  await page.goto(base + 'login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.locator('input[type="email"], input[name="email"]').first().fill('testadmin961@gmail.com');
  const passInput = page.locator('input[type="password"], input[name="password"]').first();
  for (const pass of ['admin123', 'admin1234']) {
    await passInput.fill(pass);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(2500);
    if (!page.url().includes('/login')) break;
  }
  check('admin login', !page.url().includes('/login'), page.url());

  // Go straight to the seeded booking detail.
  await page.goto(base + 'admin/bookings/' + handoff.bookingId, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => /VIOS E2E/i.test(document.body.innerText), null, { timeout: 20000 });
  } catch { /* assertions below will report */ }
  await page.waitForTimeout(1500);

  let text = await page.evaluate(() => document.body.innerText);
  check('admin opened the seeded booking detail', /VIOS E2E/i.test(text));

  const viewBtn = page.getByRole('button', { name: /view evidence/i }).first();
  const hasBtn = (await viewBtn.count()) > 0;
  check('"View Evidence" button present on admin detail', hasBtn);

  if (hasBtn) {
    await viewBtn.click().catch(() => {});
    await page.waitForTimeout(2000);
    text = await page.evaluate(() => document.body.innerText);
    const upper = text.toUpperCase();
    check('evidence drawer opened', upper.includes('PHOTO EVIDENCE'));
    check('drawer has Intake (Before) section', upper.includes('INTAKE (BEFORE)'));
    check('drawer has Completion (After) section', upper.includes('COMPLETION (AFTER)'));
  }

  out.bodySnippet = text.slice(0, 400);
  out.summary = { passed: out.checks.filter(c => c.ok).length, failed: out.checks.filter(c => !c.ok).length };
  return out;
}
