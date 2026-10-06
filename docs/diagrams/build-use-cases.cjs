// Builds the use case diagrams (SVG + PNG) for the paper. Run: node docs/diagrams/build-use-cases.cjs
// Black and white UML style so they print well. Actor on the left, system boundary in the middle, extra
// (included) use cases in a second column, outside systems on the right.
const fs = require('fs');
const path = require('path');
const sharp = require(path.join(__dirname, '../../backend/node_modules/sharp'));

const SYSTEM = 'Comar Garage Online Appointment and Scheduling Management System';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const wrap = (text, max = 26) => {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max) { lines.push(line.trim()); line = w; } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
};

const actorSvg = (x, y, name) => `
  <g stroke="#111" stroke-width="2" fill="none">
    <circle cx="${x}" cy="${y - 38}" r="12" fill="#fff"/>
    <line x1="${x}" y1="${y - 26}" x2="${x}" y2="${y + 14}"/>
    <line x1="${x - 24}" y1="${y - 14}" x2="${x + 24}" y2="${y - 14}"/>
    <line x1="${x}" y1="${y + 14}" x2="${x - 20}" y2="${y + 46}"/>
    <line x1="${x}" y1="${y + 14}" x2="${x + 20}" y2="${y + 46}"/>
  </g>
  <text x="${x}" y="${y + 66}" text-anchor="middle" font-size="15" font-weight="700" fill="#111">${wrap(name, 16).map((l, i) => `<tspan x="${x}" dy="${i ? 17 : 0}">${esc(l)}</tspan>`).join('')}</text>`;

const ellipse = (cx, cy, label, w = 250, h = 54) => {
  const lines = wrap(label, 30);
  const start = cy - ((lines.length - 1) * 8);
  return `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="#fff" stroke="#111" stroke-width="1.6"/>
  <text text-anchor="middle" font-size="13" fill="#111">${lines.map((l, i) => `<tspan x="${cx}" y="${start + i * 16 + 4}">${esc(l)}</tspan>`).join('')}</text>`;
};

/**
 * actors: [{ name, side: 'left'|'right' }]
 * cases:  [{ id, label, actors: [actorIndex...], includes: [{ label, kind: 'include'|'extend' }] }]
 */
const build = ({ title, actors, cases }) => {
  const top = 96;
  const heights = cases.map((c) => Math.max(76, (c.includes || []).length * 52 + 14));
  const centers = [];
  let acc = top;
  heights.forEach((h) => { centers.push(acc + h / 2); acc += h; });
  const H = acc + 50;
  const colA = 520; // main use cases
  const colB = 880; // included use cases
  const leftActorX = 110;
  const rightActorX = 1190;
  const W = 1300;
  const boxX = 230, boxW = 860;
  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);
  parts.push(`<text x="${W / 2}" y="34" text-anchor="middle" font-size="20" font-weight="800" fill="#111">${esc(title)}</text>`);
  parts.push(`<rect x="${boxX}" y="58" width="${boxW}" height="${H - 76}" rx="8" fill="none" stroke="#111" stroke-width="2"/>`);
  parts.push(`<text x="${boxX + boxW / 2}" y="82" text-anchor="middle" font-size="13" font-weight="700" fill="#111">${esc(SYSTEM)}</text>`);

  const midY = top + (acc - top) / 2;
  const actorPos = actors.map((a, i) => {
    // an outside system sits level with the first use case it is connected to
    const linked = cases.findIndex((c) => (c.actors || [0]).includes(i));
    return { ...a, x: a.side === 'right' ? rightActorX : leftActorX, y: a.side === 'right' ? centers[linked] : midY };
  });
  actorPos.forEach((a) => parts.push(actorSvg(a.x, a.y, a.name)));

  const lines = [];
  const shapes = [];
  cases.forEach((c, i) => {
    const cy = centers[i];
    shapes.push(ellipse(colA, cy, c.label));
    (c.actors || [0]).forEach((ai) => {
      const a = actorPos[ai];
      if (a.side === 'right') lines.push(`<line x1="${a.x - 24}" y1="${a.y - 14}" x2="${colA + 125}" y2="${cy}" stroke="#111" stroke-width="1.1"/>`);
      else lines.push(`<line x1="${a.x + 24}" y1="${a.y - 14}" x2="${colA - 125}" y2="${cy}" stroke="#111" stroke-width="1.1"/>`);
    });
    (c.includes || []).forEach((inc, k) => {
      const iy = cy + (k - ((c.includes.length - 1) / 2)) * 52;
      shapes.push(ellipse(colB, iy, inc.label, 230, 44));
      const dash = `stroke="#111" stroke-width="1.2" stroke-dasharray="6 4" marker-end="url(#arrow)"`;
      if (inc.kind === 'extend') lines.push(`<line x1="${colB - 115}" y1="${iy}" x2="${colA + 125}" y2="${cy}" ${dash}/>`);
      else lines.push(`<line x1="${colA + 125}" y1="${cy}" x2="${colB - 115}" y2="${iy}" ${dash}/>`);
      const mx = (colA + 125 + colB - 115) / 2, my = (cy + iy) / 2 - 6;
      lines.push(`<text x="${mx}" y="${my}" text-anchor="middle" font-size="11" font-style="italic" fill="#111">&#171;${inc.kind || 'include'}&#187;</text>`);
    });
  });
  parts.push(...lines, ...shapes);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="none" stroke="#111" stroke-width="1.4"/></marker></defs>
  ${parts.join('\n  ')}
</svg>`;
};

const diagrams = {
  'use-case-customer': {
    title: 'Use Case Diagram: Customer',
    actors: [{ name: 'Customer', side: 'left' }, { name: 'Email Service', side: 'right' }],
    cases: [
      { label: 'Register, Sign In, and Recover Password' },
      { label: 'Manage Vehicle Garage' },
      { label: 'Book Appointment (one or more vehicles)', includes: [{ label: 'Choose Vehicles and Services' }, { label: 'Pick Date and Time' }, { label: 'Pay Downpayment and Upload Receipt' }] },
      { label: 'Add Service to Booking', includes: [{ label: 'Pay Required Amount (if due)', kind: 'extend' }] },
      { label: 'Pay Remaining Balance', includes: [{ label: 'Upload Receipt' }] },
      { label: 'Track Booking Progress' },
      { label: 'View Photo Proof and Service Notes' },
      { label: 'Reschedule Booking' },
      { label: 'Cancel Booking (refund is queued)' },
      { label: 'Book Again' },
      { label: 'View Transactions, Receipts, and Refunds' },
      { label: 'Chat with the Shop' },
      { label: 'Send Saved Booking Details to the Shop' },
      { label: 'Receive Notifications and Reminders', actors: [0, 1] },
      { label: 'Manage Profile and Password' }
    ]
  },
  'use-case-staff': {
    title: 'Use Case Diagram: Staff (Technician)',
    actors: [{ name: 'Staff (Technician)', side: 'left' }, { name: 'Email Service', side: 'right' }],
    cases: [
      { label: 'Sign In and Manage Profile' },
      { label: 'Clock In and Clock Out' },
      { label: 'View Assigned Vehicles' },
      { label: 'Start Job', includes: [{ label: 'Upload Before-Service Photo' }] },
      { label: 'Finish Job', includes: [{ label: 'Upload After-Service Photo' }] },
      { label: 'Write Service Notes' },
      { label: 'View Work History' },
      { label: 'View Own Reports (if enabled by the Administrator)' },
      { label: 'Receive Assignment Notifications and Announcements', actors: [0, 1] }
    ]
  },
  'use-case-administrator': {
    title: 'Use Case Diagram: Administrator',
    actors: [{ name: 'Administrator', side: 'left' }, { name: 'Email Service', side: 'right' }],
    cases: [
      { label: 'Sign In and Manage Profile' },
      { label: 'View Dashboard (items needing attention)' },
      { label: 'Manage Bookings (confirm, reschedule, cancel, release)' },
      { label: 'Add Services and Record Payments', includes: [{ label: 'Upload Receipt or Enter by Hand' }] },
      { label: 'Assign Technician to Each Vehicle' },
      { label: 'Create Walk-In Booking' },
      { label: 'Book for Customer from Chat', includes: [{ label: 'Invite Customer to Send Details', kind: 'include' }] },
      { label: 'Verify or Reject Payments', includes: [{ label: 'Read Receipt (OCR)' }] },
      { label: 'Process Refunds', includes: [{ label: 'Issue Refund Receipt' }] },
      { label: 'Manage Calendar and Block Slots' },
      { label: 'Reply to Customer Messages' },
      { label: 'Review Service Photos and Notes' },
      { label: 'Generate Reports', includes: [{ label: 'Print Today\'s Report' , kind: 'extend' }, { label: 'Export PDF or CSV', kind: 'extend' }] },
      { label: 'View Audit Logs' },
      { label: 'Manage Staff and Administrator Accounts', includes: [{ label: 'Send Invitation', kind: 'extend' }, { label: 'Set Auto-Deactivation and Reactivate', kind: 'extend' }] },
      { label: 'Manage Customer Directory' },
      { label: 'Configure Business Hub Settings' },
      { label: 'Send Notifications and Announcements', actors: [0, 1] }
    ]
  }
};

(async () => {
  for (const [name, spec] of Object.entries(diagrams)) {
    const svg = build(spec);
    fs.writeFileSync(path.join(__dirname, `${name}.svg`), svg);
    await sharp(Buffer.from(svg), { density: 150 }).png().toFile(path.join(__dirname, `${name}.png`));
    console.log('built', name);
  }
})();
