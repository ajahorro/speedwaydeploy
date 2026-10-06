// Booking pipeline (conceptual design), DFD Level 0, and system architecture.
// Run: node docs/diagrams/build-system-diagrams.cjs
const { wrap, txt, svgWrap, title, box, arr, save, esc } = require('./lib.cjs');

/** Box with a bold title bar text and bullet lines under it (left aligned). */
const boxList = (cx, cy, w, h, head, items, o = {}) => {
  const x = cx - w / 2; const y = cy - h / 2;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 10}" fill="#fff" stroke="#111" stroke-width="1.8"${o.dashed ? ' stroke-dasharray="7 4"' : ''}/>`;
  s += `<rect x="${x}" y="${y}" width="${w}" height="30" rx="${o.rx ?? 10}" fill="#111"/>`;
  s += `<text x="${cx}" y="${y + 20}" text-anchor="middle" font-size="13" font-weight="800" fill="#fff">${esc(head)}</text>`;
  let ty = y + 52;
  items.forEach((it) => {
    const ls = wrap(it, o.max || Math.floor((w - 30) / 6.1));
    s += `<text font-size="11.5" fill="#111"><tspan x="${x + 12}" y="${ty}">•</tspan>${ls.map((l, i) => `<tspan x="${x + 24}" y="${ty + i * 14}">${esc(l)}</tspan>`).join('')}</text>`;
    ty += ls.length * 14 + 8;
  });
  return s;
};

// ───────────────────────── Booking pipeline ─────────────────────────
const pipeline = () => {
  const W = 1400, H = 985;
  const p = [title(W, 'Conceptual Design: The Booking Pipeline (Status, Payment, and Refund)')];
  const lane = (y, h, head) => {
    p.push(`<rect x="40" y="${y}" width="1320" height="${h}" rx="10" fill="none" stroke="#111" stroke-width="1.8"/>`);
    p.push(`<rect x="40" y="${y}" width="1320" height="30" rx="10" fill="#111"/>`);
    p.push(`<text x="60" y="${y + 20}" font-size="13" font-weight="800" fill="#fff">${esc(head)}</text>`);
  };
  const xs = [170, 520, 870, 1220];

  // lane 1: booking status
  lane(60, 475, '1. Booking status');
  const A = 185;
  [['Scheduled', 'Booking created; it holds its time slot'], ['Confirmed', 'Downpayment paid and technicians set'], ['In progress', 'Work on the vehicles has started'], ['Completed', 'All vehicles done and fully paid']]
    .forEach(([h, s], i) => p.push(box(xs[i], A, 190, 66, h, s, { rx: 30 })));
  p.push(arr([[265, A], [425, A]], 'Downpayment verified and every vehicle has a technician', [345, 124], { max: 24 }));
  p.push(arr([[615, A], [775, A]], 'Staff starts the first vehicle', [695, 138], { max: 24 }));
  p.push(arr([[965, A], [1125, A]], 'All vehicles are done and the booking is fully paid', [1045, 130], { max: 24 }));
  p.push(box(345, 330, 190, 60, 'No-show flagged', 'Undo allowed for 24 hours', { rx: 30 }));
  p.push(arr([[200, 218], [300, 300]]));
  p.push(arr([[495, 218], [390, 300]]));
  p.push(txt(345, 262, 'Not started 1 hour after the start time', 17, 11.5, 600));
  p.push(arr([[440, 330], [520, 330], [520, 218]], 'Admin undo', [528, 290, 'start'], { max: 10 }));
  p.push(box(420, 462, 700, 56, 'Cancelled', 'Final state. Any payment made moves to the refund track below', { rx: 28, fill: '#eee' }));
  p.push(arr([[110, 218], [110, 434]], 'Customer or admin cancels, or the unpaid hold expires (30 min)', [118, 322, 'start'], { max: 16 }));
  p.push(arr([[345, 360], [345, 434]], 'After 24 hours, or an admin cancels', [353, 398, 'start'], { max: 18 }));
  p.push(arr([[605, 218], [605, 434]], 'Customer or admin cancels before work starts', [613, 322, 'start'], { max: 20 }));
  p.push(box(1045, 400, 520, 92, 'Once work starts', 'The customer can no longer cancel or reschedule. A booking completes by itself when every vehicle is done and the balance is paid.', { rx: 12, dashed: true, sub: true }));

  // lane 2: payment
  lane(550, 215, '2. Payment');
  const B = 665;
  [['Unpaid', 'Nothing verified yet'], ['Waiting for verification', 'Receipt or reference submitted'], ['Partially paid', 'Required downpayment can be met here'], ['Paid in full', 'Balance is zero']]
    .forEach(([h, s], i) => p.push(box(xs[i], B, 190, 70, h, s, { rx: 12 })));
  p.push(arr([[265, B], [425, B]], 'Receipt uploaded and read (OCR); cash recorded by the administrator', [345, 612], { max: 25 }));
  p.push(arr([[615, B], [775, B]], 'Administrator verifies an amount below the total', [695, 616], { max: 24 }));
  p.push(arr([[965, B], [1125, B]], 'Balance paid and verified', [1045, 625], { max: 22 }));
  p.push(arr([[470, B + 35], [470, 733], [170, 733], [170, B + 35]], 'Rejected: the customer sends a new proof', [320, 726], { max: 40 }));
  p.push(arr([[570, B + 35], [570, 750], [1220, 750], [1220, B + 35]], 'Verified amount covers the whole total', [900, 743], { max: 40 }));

  // lane 3: refund
  lane(780, 170, '3. Refund after cancellation');
  const C = 875;
  [['Refund queued', 'Cancelled booking that had a payment'], ['Administrator reviews', 'In the Refund Hub; amount decided'], ['Refund recorded', 'Payment shows as Refunded'], ['Customer informed', 'Refund receipt sent by email']]
    .forEach(([h, s], i) => p.push(box(xs[i], C, 190, 70, h, s, { rx: 12 })));
  p.push(arr([[265, C], [425, C]], 'Admin opens the queue', [345, 836], { max: 22 }));
  p.push(arr([[615, C], [775, C]], 'Refund paid out and saved', [695, 836], { max: 22 }));
  p.push(arr([[965, C], [1125, C]], 'Receipt is generated', [1045, 842], { max: 22 }));
  p.push(arr([[70, 462], [22, 462], [22, C], [75, C]], '', null, { dashed: true }));
  p.push(`<text transform="translate(14 ${(462 + C) / 2}) rotate(-90)" text-anchor="middle" font-size="11" font-weight="700" fill="#111">If a payment was made</text>`);
  p.push(`<text x="40" y="972" font-size="11.5" fill="#111">Key: each band is its own status track. The Confirmed rule joins the tracks: the downpayment must be verified in the payment track before a booking can be confirmed. Cancelling feeds the refund track.</text>`);
  return svgWrap(W, H, p.join('\n'));
};

// ───────────────────────── DFD Level 0 ─────────────────────────
const dfd0 = () => {
  const W = 1500, H = 910;
  const p = [title(W, 'Data Flow Diagram (Level 0): Context Diagram')];
  p.push(`<ellipse cx="750" cy="450" rx="190" ry="140" fill="#fff" stroke="#111" stroke-width="2.2"/>`);
  p.push(`<text x="750" y="400" text-anchor="middle" font-size="15" font-weight="800" fill="#111">0</text>`);
  p.push(txt(750, 455, 'Comar Garage Online Appointment and Scheduling System', 24, 16, 800));
  const ent = (cx, cy, w, h, name) => p.push(box(cx, cy, w, h, name, '', { rx: 0, sw: 2.2, size: 15, max: 22 }));
  ent(140, 450, 200, 150, 'Customer');
  ent(1360, 450, 200, 150, 'Administrator');
  ent(750, 95, 240, 70, 'Staff');
  ent(750, 815, 260, 70, 'Email Service');
  // customer
  p.push(arr([[240, 400], [572, 400]], 'Sign-up and sign-in details, booking requests, payment receipts, reschedule, cancel, and add-service requests, chat messages', [406, 340], { max: 36 }));
  p.push(arr([[572, 500], [240, 500]], 'Available times and prices, booking confirmations, payment status, receipts, refund updates, notifications', [406, 560], { max: 36 }));
  // administrator
  p.push(arr([[1260, 400], [928, 400]], 'Business settings, services, promos, closures, walk-in bookings, payment checks, refund decisions, staff accounts and invitations', [1094, 340], { max: 36 }));
  p.push(arr([[928, 500], [1260, 500]], 'Bookings, payments, refunds, reports, dashboards, audit logs, alerts', [1094, 552], { max: 36 }));
  // staff
  p.push(arr([[640, 130], [640, 337]], 'Sign-in, shift start and end, vehicle start and finish, service photos', [630, 235, 'end'], { max: 26 }));
  p.push(arr([[860, 337], [860, 130]], 'Assigned vehicles and schedule, task notifications', [870, 235, 'start'], { max: 26 }));
  // email
  p.push(arr([[640, 563], [640, 780]], 'Confirmations, receipts, reminders, invitations, recovery and security messages', [630, 672, 'end'], { max: 28 }));
  p.push(arr([[860, 780], [860, 563]], 'Delivery results', [870, 672, 'start'], { max: 28 }));
  p.push(`<text x="40" y="885" font-size="11.5" fill="#111">Key: rectangle = external entity; ellipse = the whole system as a single process; arrow = data flow. The email messages reach customers, staff, and administrators through the email service.</text>`);
  return svgWrap(W, H, p.join('\n'));
};

// ───────────────────────── System architecture ─────────────────────────
const architecture = () => {
  const W = 1500, H = 1020;
  const p = [title(W, 'System Architecture')];
  p.push(box(350, 80, 560, 60, 'Customers, staff, and administrators', 'Phone or computer browser', { rx: 12 }));
  p.push(arr([[350, 110], [350, 175]], 'Open the website', [360, 142, 'start'], { max: 20 }));
  p.push(boxList(350, 285, 580, 220, 'Web application on Vercel (comargarage.com)', [
    'Built with React and Vite; one site with customer, staff, and administrator screens',
    'Booking wizard, payment and receipt screens, chat, reports',
    'Automatic sign-out after 60 minutes without activity',
    'Receives live updates without reloading'
  ]));
  p.push(boxList(1110, 285, 640, 220, 'Backend service on Render (Express)', [
    'Sensitive actions that need the server: cancel, add service, reconcile payments, staff accounts and invitations',
    'Receipt reading (OCR) with Tesseract',
    'Scheduled jobs: every 5 minutes (overdue and no-show check, unpaid-hold release, login notices); every 24 hours (inactive-staff check)',
    'Checks the signed-in user and role on every request'
  ]));
  p.push(arr([[640, 285], [790, 285]], 'Sensitive requests with the sign-in token', [715, 246], { max: 18 }));
  // supabase platform
  p.push(`<rect x="50" y="520" width="1400" height="330" rx="14" fill="none" stroke="#111" stroke-width="2.2"/>`);
  p.push(`<rect x="50" y="520" width="1400" height="32" rx="14" fill="#111"/>`);
  p.push(`<text x="750" y="542" text-anchor="middle" font-size="14" font-weight="800" fill="#fff">Supabase platform</text>`);
  const xs = [195, 480, 765, 1050, 1305];
  const specs = [
    ['Authentication', ['Sign-in and sessions', 'Password recovery', 'Sign-in lockout and security notices'], 220],
    ['PostgreSQL database', ['Tables with row-level security, functions, and triggers', 'Audit log and notifications', 'Scheduled jobs: no-show lifecycle every 5 minutes, photo clean-up daily'], 270],
    ['Realtime', ['Pushes changes to open screens', 'Chat, bookings, payments, notifications'], 220],
    ['Storage', ['payment-receipts', 'chat_media', 'Service photos'], 220],
    ['Edge functions', ['booking-lifecycle (status emails and receipts)', 'send-notification-email', 'send-refund-receipt', 'send-status-email'], 250]
  ];
  let cursor = 70;
  const gap = 18;
  const totalW = specs.reduce((a, s) => a + s[2], 0) + gap * (specs.length - 1);
  cursor = 50 + (1400 - totalW) / 2;
  const centers = [];
  specs.forEach(([head, items, w]) => {
    p.push(boxList(cursor + w / 2, 700, w, 240, head, items, { max: Math.floor((w - 30) / 6.1) }));
    centers.push(cursor + w / 2);
    cursor += w + gap;
  });
  // app -> supabase
  p.push(arr([[200, 395], [200, 520]], 'Sign-in, reads and writes (row-level security), live updates, file uploads', [210, 457, 'start'], { max: 34 }));
  p.push(arr([[1000, 395], [1000, 520]], 'Service-level reads and writes, scheduled jobs', [1010, 457, 'start'], { max: 30 }));
  p.push(arr([[1300, 395], [1300, 520]], 'Email requests', [1310, 457, 'start'], { max: 20 }));
  // edge -> resend -> inboxes
  const ex = centers[4];
  p.push(box(ex, 940, 300, 58, 'Resend (email service)', 'Delivers the emails to inboxes', { rx: 10 }));
  p.push(arr([[ex, 820], [ex, 911]], 'Emails', [ex + 10, 866, 'start'], { max: 14 }));
  p.push(`<text x="60" y="990" font-size="11.5" fill="#111">Key: the web application talks to Supabase directly for ordinary data, protected by row-level security, and to the backend only for actions that need the server to decide. All emails go through the Supabase edge functions to Resend.</text>`);
  return svgWrap(W, H, p.join('\n'));
};

(async () => {
  await save(__dirname, { 'booking-pipeline': pipeline(), 'dfd-level0-context': dfd0(), 'system-architecture': architecture() });
})();
