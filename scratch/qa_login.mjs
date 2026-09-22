export default async function run(page, ui) {
  const email = process.env.QA_EMAIL;
  const password = process.env.QA_PASSWORD;

  await ui.fill('@e1', email);
  await ui.fill('@e2', password);
  await ui.click('@e3');

  // Wait for navigation away from /login or an error toast.
  try {
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), null, { timeout: 20000 });
  } catch (e) {
    const snap = await ui.snapshot({ full: true });
    return { ok: false, note: 'stayed on /login', url: page.url(), snap };
  }

  await page.waitForTimeout(1500);
  const snap = await ui.snapshot({ full: true });
  return { ok: true, url: page.url(), snap };
}
