// Drives the profile dropdown for one role and reports results.
// Registered as a module so it can be reused per role.
const ROLE_MATRIX = {
  admin: { email: 'testadmin961@gmail.com', passwords: ['admin1234', 'admin123'], label: 'Administrator', home: '/admin', profile: '/admin/profile', settings: '/admin/settings' },
  customer: { email: 'jayneahorro@gmail.com', passwords: ['jayne1234', 'jayne123'], label: 'Customer', home: '/customer', profile: '/customer/profile', settings: '/customer/settings' },
  staff: { email: 'staff1@speedway.com', passwords: ['staff1234', 'staff123'], label: 'Staff Member', home: '/staff', profile: '/staff/profile', settings: '/staff/settings' },
};

export default async function run(page, ui) {
  const role = process.env.TEST_ROLE || 'staff';
  const cfg = ROLE_MATRIX[role];
  const out = { role, consoleErrors: [], steps: [] };

  page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => out.consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"], input[name="email"]').first().fill(cfg.email);

  let loggedIn = false;
  for (const pw of cfg.passwords) {
    await page.locator('input[type="password"]').first().fill(pw);
    await page.getByRole('button', { name: /sign in|log in|login/i }).first().click();
    await page.waitForTimeout(3500);
    if (!page.url().includes('/login')) { loggedIn = true; out.steps.push(`login OK with "${pw}" -> ${page.url()}`); break; }
    out.steps.push(`login attempt "${pw}" failed, still on ${page.url()}`);
  }
  if (!loggedIn) return { ...out, error: 'LOGIN FAILED' };

  // Open the dropdown
  const snap = await ui.snapshot();
  const trigger = snap.match(/@(e\d+) button "[^"]*(Administrator|Customer|Staff Member)[^"]*"/)
    || snap.match(/@(e\d+) button [^\n]*\[haspopup=menu\]/);
  if (!trigger) return { ...out, error: 'NO DROPDOWN TRIGGER', snap };

  await ui.click(trigger[1]);
  await page.waitForTimeout(600);
  const menu = await ui.snapshot();
  out.steps.push('menu: ' + menu.replace(/\n/g, ' | '));
  const hasProfile = /menuitem "My Profile"/.test(menu);
  const hasSettings = /menuitem "Settings"/.test(menu);
  const hasLogout = /menuitem "Logout"/.test(menu);
  out.steps.push(`menu items -> profile:${hasProfile} settings:${hasSettings} logout:${hasLogout}`);

  // Click My Profile
  const mp = menu.match(/@(e\d+) menuitem "My Profile"/);
  if (mp) {
    await ui.click(mp[1]);
    await page.waitForTimeout(2500);
    out.steps.push(`after My Profile -> ${page.url()} (expected ${cfg.profile})`);
  }

  // Re-open, click Settings
  await page.goto('http://localhost:5173' + cfg.home, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const snap2 = await ui.snapshot();
  const t2 = snap2.match(/@(e\d+) button [^\n]*\[haspopup=menu\]/);
  if (t2) {
    await ui.click(t2[1]);
    await page.waitForTimeout(600);
    const menu2 = await ui.snapshot();
    const st = menu2.match(/@(e\d+) menuitem "Settings"/);
    if (st) {
      await ui.click(st[1]);
      await page.waitForTimeout(2500);
      out.steps.push(`after Settings -> ${page.url()} (expected ${cfg.settings})`);
    }
  }

  // Re-open, click Logout (should open modal, not sign out directly)
  await page.goto('http://localhost:5173' + cfg.home, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const snap3 = await ui.snapshot();
  const t3 = snap3.match(/@(e\d+) button [^\n]*\[haspopup=menu\]/);
  if (t3) {
    await ui.click(t3[1]);
    await page.waitForTimeout(600);
    const menu3 = await ui.snapshot();
    const lo = menu3.match(/@(e\d+) menuitem "Logout"/);
    if (lo) {
      await ui.click(lo[1]);
      await page.waitForTimeout(1200);
      const modalText = await page.evaluate(() => {
        const el = document.querySelector('.app-modal, [role="dialog"]');
        return el ? el.innerText.replace(/\n+/g, ' | ') : 'NO MODAL';
      });
      out.steps.push('logout modal: ' + modalText);
      // dismiss
      const cancel = page.locator('.app-modal-actions button').first();
      if (await cancel.count()) await cancel.click().catch(() => { });
    }
  }

  return out;
}