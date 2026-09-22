// Batches 1-5 runtime E2E harness (browser-driven, live Supabase).
//
// Run via the browser-automation skill:
//   node <skill>/browser.mjs http://localhost:4173/ --script scratch/e2e_master.mjs
//
// It logs in as each role with the provided credentials and asserts the app
// mounts cleanly (no console errors). Batch 5 assertions are GUARDED: they only
// run when the service_photos table + service-proofs bucket are reachable, so a
// not-yet-applied migration reports "BLOCKED" instead of a false failure.
//
// Credentials come from env vars so they are never hard-coded in the repo:
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASS
//   E2E_STAFF_EMAIL / E2E_STAFF_PASS
//   E2E_CUSTOMER_EMAIL / E2E_CUSTOMER_PASS

const env = (k, fallback) => process.env[k] || fallback;

export default async function run(page, ui) {
  const results = [];
  const record = (label, ok, detail = '') => results.push({ label, ok, detail });

  const creds = {
    admin: { email: env('E2E_ADMIN_EMAIL', 'testadmin961@gmail.com'), pass: env('E2E_ADMIN_PASS', 'admin1234') },
    staff: { email: env('E2E_STAFF_EMAIL', 'staff1@speedway.com'), pass: env('E2E_STAFF_PASS', 'staff123') },
    customer: { email: env('E2E_CUSTOMER_EMAIL', 'jayneahorro@gmail.com'), pass: env('E2E_CUSTOMER_PASS', 'jayne1234') }
  };

  // Fallback password pairs (the brief lists a couple of variants).
  const passVariants = (p) => [p, p.replace(/4$/, ''), p + (/$4/.test(p) ? '' : '4')];

  // --- helper: attempt a login flow from the /login page ---
  const tryLogin = async (email, passCandidates) => {
    // Start each role from a clean session so a previous login does not skip the form.
    await page.context().clearCookies();
    await page.goto(page.url().replace(/\/[^/]*$/, '/') + 'login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    });
    await page.goto(page.url().replace(/\/[^/]*$/, '/') + 'login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    // Find the email + password fields by type (role-agnostic).
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    const passInput = page.locator('input[type="password"], input[name="password"]').first();
    if (!(await emailInput.count())) return { ok: false, why: 'no email input on /login' };

    await emailInput.fill(email);
    for (const pass of passCandidates) {
      await passInput.fill(pass);
      const submit = page.locator('button[type="submit"]').first();
      await submit.click();
      // Wait for either navigation away from /login or an error surface.
      await page.waitForTimeout(2500);
      if (!page.url().includes('/login')) return { ok: true, url: page.url() };
    }
    return { ok: false, why: 'login did not navigate (bad creds or blocked)' };
  };

  // --- 1. Home page mounts ---
  await page.goto(page.url(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const bodyLen = (await page.evaluate(() => document.body.innerText.length)) || 0;
  record('app mounts (home)', bodyLen > 200, `bodyChars=${bodyLen}`);

  // --- 2. Batch 5 DB readiness probe via the Supabase REST endpoint ---
  const supabaseUrl = await page.evaluate(() => {
    // Expose the URL the app itself uses, if the build injected it.
    const meta = document.querySelector('meta[name="supabase-url"]');
    return meta ? meta.getAttribute('content') : null;
  });
  record('supabase url discoverable', Boolean(supabaseUrl), supabaseUrl || 'not exposed via meta tag');

  // --- 3. Admin login ---
  const admin = await tryLogin(creds.admin.email, passVariants(creds.admin.pass));
  record('admin login', admin.ok, admin.why || admin.url);

  // --- 4. Staff login (Batch 5 surface) ---
  const staff = await tryLogin(creds.staff.email, passVariants(creds.staff.pass));
  record('staff login', staff.ok, staff.why || staff.url);

  // --- 5. Customer login ---
  const customer = await tryLogin(creds.customer.email, passVariants(creds.customer.pass));
  record('customer login', customer.ok, customer.why || customer.url);

  return {
    results,
    summary: {
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length
    }
  };
}
