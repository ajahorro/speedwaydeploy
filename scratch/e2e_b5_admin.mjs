// Batch 5 UI probe #2: log in as ADMIN, open the bookings list, open the first
// booking detail, and confirm the "View Evidence" button renders and the
// PhotoProofGallery drawer opens. This exercises the real data path.
export default async function run(page /*, ui*/) {
  const out = { steps: [] };

  await page.context().clearCookies();
  await page.goto(page.url().replace(/\/[^/]*$/, '/') + 'login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
  await page.goto(page.url().replace(/\/[^/]*$/, '/') + 'login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.locator('input[type="email"], input[name="email"]').first().fill('testadmin961@gmail.com');
  const passInput = page.locator('input[type="password"], input[name="password"]').first();
  for (const pass of ['admin1234', 'admin123']) {
    await passInput.fill(pass);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(2500);
    if (!page.url().includes('/login')) break;
  }
  out.steps.push({ step: 'admin login', url: page.url() });

  // Find a link into a booking detail page and follow the first one.
  const bookingHref = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href*="/admin/bookings/"]')]
      .map((el) => el.getAttribute('href'))
      .filter((h) => h && /\/admin\/bookings\/[^/]+$/.test(h));
    return a[0] || null;
  });
  out.bookingHrefFound = Boolean(bookingHref);

  if (bookingHref) {
    await page.goto('http://localhost:5173' + bookingHref, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const text = await page.evaluate(() => document.body.innerText);
    out.onDetailPage = page.url().includes('/admin/bookings/');
    out.hasViewEvidence = text.includes('VIEW EVIDENCE') || text.includes('View Evidence');

    // Click View Evidence and confirm the drawer opens.
    if (out.hasViewEvidence) {
      const btn = page.getByText(/view evidence/i).first();
      await btn.click().catch(() => { });
      await page.waitForTimeout(1500);
      const drawerText = await page.evaluate(() => document.body.innerText);
      out.drawerOpened = drawerText.includes('PHOTO EVIDENCE') || drawerText.includes('Photo Evidence');
      out.drawerHasSections = drawerText.includes('Intake (Before)') && drawerText.includes('Completion (After)');
    }
  }

  return out;
}
