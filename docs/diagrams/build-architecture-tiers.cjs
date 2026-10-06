// Three-tier architecture framework (client, logic, data layers). Run: node docs/diagrams/build-architecture-tiers.cjs
const { wrap, txt, svgWrap, arr, save, esc } = require('./lib.cjs');

const panel = (x, y, w, h, head, sub) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#f4f4f4" stroke="#bbb" stroke-width="1.4"/>`
  + txt(x + w / 2, y + 30, head, 40, 15, 800) + txt(x + w / 2, y + 50, sub, 44, 12, 400);
const card = (x, y, w, h, head, sub, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 8}" fill="#fff" stroke="#111" stroke-width="${o.sw || 1.5}"/>`
  + (sub ? txt(x + w / 2, y + 22, head, Math.floor(w / 7), 12.5, 800) + txt(x + w / 2, y + 22 + 14 + (wrap(sub, Math.floor(w / 6)).length * 14) / 2 + 2, sub, Math.floor(w / 6), 11, 400)
    : txt(x + w / 2, y + h / 2, head, Math.floor(w / 7), 12.5, 800));
const laptop = (cx, cy) => `<rect x="${cx - 22}" y="${cy - 16}" width="44" height="28" rx="3" fill="#fff" stroke="#111" stroke-width="2"/><line x1="${cx - 30}" y1="${cy + 18}" x2="${cx + 30}" y2="${cy + 18}" stroke="#111" stroke-width="3"/><circle cx="${cx}" cy="${cy - 5}" r="5" fill="#111"/>`;
const phone = (cx, cy) => `<rect x="${cx - 13}" y="${cy - 22}" width="26" height="44" rx="5" fill="#fff" stroke="#111" stroke-width="2"/><line x1="${cx - 5}" y1="${cy + 15}" x2="${cx + 5}" y2="${cy + 15}" stroke="#111" stroke-width="2"/>`;
const dbIcon = (cx, cy) => `<ellipse cx="${cx}" cy="${cy - 14}" rx="20" ry="7" fill="#fff" stroke="#111" stroke-width="2"/><path d="M${cx - 20},${cy - 14} L${cx - 20},${cy + 14} A20,7 0 0 0 ${cx + 20},${cy + 14} L${cx + 20},${cy - 14}" fill="#fff" stroke="#111" stroke-width="2"/><path d="M${cx - 20},${cy} A20,7 0 0 0 ${cx + 20},${cy}" fill="none" stroke="#111" stroke-width="1.6"/>`;
const cloud = (cx, cy) => `<path d="M${cx - 30},${cy + 14} A14,14 0 0 1 ${cx - 26},${cy - 12} A18,18 0 0 1 ${cx + 8},${cy - 18} A15,15 0 0 1 ${cx + 30},${cy - 2} A12,12 0 0 1 ${cx + 24},${cy + 14} Z" fill="#fff" stroke="#111" stroke-width="2"/>`;

const arch = () => {
  const W = 1560, H = 950;
  const p = [];
  // T1 client layer
  p.push(panel(20, 20, 450, 620, 'T1.0 CLIENT LAYER', '(ACCESS AND DEVICES)'));
  const actors = [
    ['Administrator', 'Laptop or desktop', laptop, 'Business Hub and Financial Review', 'Bookings, payments, refunds, reports, staff accounts, shop rules'],
    ['Staff', 'Mobile phone or tablet', phone, 'Mobile Hub', 'Clock in and out, assigned vehicles, status updates, service photos'],
    ['Customer', 'Mobile phone or web', phone, 'Self-service Booking and Tracking', 'Book, pay, follow progress, reschedule or cancel, chat']
  ];
  actors.forEach(([name, dev, icon, mod, sub], i) => {
    const cy = 185 + i * 175;
    p.push(`<rect x="36" y="${cy - 70}" width="160" height="140" rx="10" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
    p.push(icon(116, cy - 28));
    p.push(txt(116, cy + 22, name, 18, 14, 800));
    p.push(txt(116, cy + 44, dev, 22, 11, 400));
    p.push(card(222, cy - 62, 230, 124, mod, sub, { rx: 10 }));
    p.push(arr([[196, cy], [222, cy]]));
    p.push(arr([[452, cy], [486, cy]], '', null, { noHead: true }));
  });
  p.push(`<path d="M486,185 L486,535" stroke="#111" stroke-width="1.6" fill="none"/>`);
  p.push(arr([[486, 360], [515, 360]], '', null, {}));
  // internet
  p.push(cloud(548, 355));
  p.push(txt(548, 392, 'INTERNET', 12, 11.5, 800));
  p.push(txt(548, 407, '(HTTPS / TLS)', 14, 10.5, 400));
  p.push(arr([[580, 355], [616, 355]]));

  // T2 logic layer
  p.push(panel(600, 20, 440, 620, 'T2.0 LOGIC LAYER', '(WEB APPLICATION AND SERVER)'));
  p.push(`<rect x="620" y="85" width="400" height="130" rx="10" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
  p.push(txt(820, 108, 'Web application (React and Vite)', 40, 13.5, 800));
  p.push(txt(820, 155, 'Hosted on Vercel at comargarage.com. Separate screens for customers, staff, and administrators; live updates; automatic sign-out after 60 minutes of no activity', 56, 11, 400));
  p.push(arr([[820, 215], [820, 245]], 'Sensitive requests', [830, 235, 'start'], { max: 20 }));
  p.push(`<rect x="620" y="245" width="400" height="378" rx="10" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
  p.push(txt(820, 268, 'Backend service (Express), hosted on Render', 44, 13.5, 800));
  const mods = [
    ['Booking rules', 'Hours, closed days, minimum notice, capacity'],
    ['Technician assignment', 'Set per vehicle by the administrator; workload limit per staff'],
    ['Receipt reading (OCR)', 'Tesseract reads the amount, reference, and account'],
    ['Access control', 'Role and ownership check on every request'],
    ['Scheduled jobs', 'No-show check, unpaid-hold release, idle-staff check'],
    ['Notification engine', 'In-app notices and emails for every status change']
  ];
  mods.forEach(([h, s], i) => {
    const col = i % 2; const row = Math.floor(i / 2);
    p.push(card(632 + col * 192, 284 + row * 112, 184, 100, h, s));
  });

  // T3 data layer
  p.push(panel(1090, 20, 450, 620, 'T3.0 DATA LAYER', '(BACKEND AS A SERVICE)'));
  p.push(`<rect x="1110" y="85" width="410" height="535" rx="10" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
  p.push(dbIcon(1160, 125));
  p.push(txt(1330, 118, 'Supabase', 20, 16, 800));
  p.push(txt(1330, 138, '(PostgreSQL database)', 30, 12, 400));
  const rows = [
    ['User accounts and roles', 'Protected by row-level security'],
    ['Booking records', 'Schedule, vehicles, services, status'],
    ['Customer garage', 'Saved vehicles for faster booking'],
    ['Payments and refunds', 'One ledger with receipts'],
    ['Audit log and notifications', 'Who did what and when'],
    ['Shop rules', 'Hours, services, promos, closures']
  ];
  rows.forEach(([h, s], i) => {
    const y = 170 + i * 52;
    p.push(`<rect x="1130" y="${y}" width="370" height="44" rx="6" fill="#fff" stroke="#111" stroke-width="1.3"/>`);
    p.push(`<text x="1144" y="${y + 19}" font-size="12.5" font-weight="800" fill="#111">${esc(h)}</text>`);
    p.push(`<text x="1144" y="${y + 35}" font-size="11" fill="#111">${esc(s)}</text>`);
  });
  p.push(`<rect x="1130" y="490" width="370" height="114" rx="6" fill="#f4f4f4" stroke="#111" stroke-width="1.3" stroke-dasharray="6 4"/>`);
  p.push(txt(1315, 512, 'Supabase platform services', 30, 12.5, 800));
  p.push(txt(1315, 560, 'Sign-in and sessions, live updates (Realtime), file storage for receipts and photos, email functions, and scheduled database jobs', 52, 11, 400));
  // links between tiers
  p.push(arr([[1020, 135], [1110, 135]], 'Direct data access', [1065, 110], { max: 10 }));
  p.push(arr([[1020, 450], [1110, 450]], 'Server access', [1065, 428], { max: 10 }));

  // external services
  p.push(`<rect x="1090" y="680" width="450" height="130" rx="12" fill="#fff" stroke="#111" stroke-width="1.8" stroke-dasharray="7 4"/>`);
  p.push(txt(1315, 702, 'EXTERNAL SERVICES', 30, 12.5, 800));
  p.push(card(1110, 718, 200, 78, 'Resend', 'Delivers the emails'));
  p.push(card(1330, 718, 190, 78, 'GCash and bank apps', 'Customer pays there, then uploads the receipt'));
  p.push(arr([[920, 623], [920, 757], [1110, 757]], 'Emails', [950, 745, 'start'], { max: 14 }));

  // security and performance
  const band = (y, label, items) => {
    p.push(`<text x="30" y="${y + 40}" font-size="14" font-weight="800" fill="#111">${label}</text>`);
    items.forEach(([h, s], i) => p.push(card(190 + i * 215, y, 205, 78, h, s, { sw: 1.3 })));
  };
  band(690, 'SECURITY', [['Encrypted in transit', 'HTTPS everywhere'], ['Row-level security', 'And a role check on every request'], ['Sign-in protection', 'Lockout and automatic sign-out']]);
  band(790, 'PERFORMANCE', [['Cloud hosting', 'Vercel, Render, and Supabase scale without servers to manage'], ['Live updates', 'Screens update without reloading'], ['Edge delivery', "The website is served from Vercel's edge network"]]);
  p.push(`<text x="30" y="915" font-size="11.5" fill="#111">Key: T1 is what people use, T2 is the web application and the backend that decide and check, T3 is where the data is kept. Ordinary data goes straight to Supabase, protected by row-level security; sensitive actions go through the backend.</text>`);
  return svgWrap(W, H, p.join('\n'));
};

(async () => { await save(__dirname, { 'architecture-three-tier': arch() }); })();
