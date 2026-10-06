// Logical DFD (Level 1, operations) and the data flow matrices.
// Run: node docs/diagrams/build-dfd-ops.cjs
const { txt, svgWrap, title, arr, save, esc, wrap } = require('./lib.cjs');

const lab = (x, y, label, max = 36) => { const ls = wrap(label, max); return '<text text-anchor="middle" font-size="11.5" font-weight="600" fill="#111">' + ls.map((l, k) => '<tspan x="' + x + '" y="' + (y - 7 - (ls.length - 1 - k) * 14) + '">' + esc(l) + '</tspan>').join('') + '</text>'; };
const bi = (x1, y, x2, label, lab2) => arr([[x1, y], [x2, y]]) + lab(lab2[0], y, label) + '<path d="M' + (x1 + 2) + ',' + y + ' L' + x1 + ',' + y + '" stroke="#111" stroke-width="1.6" fill="none" marker-end="url(#a)"/>';

const procs = [
  ['1.0', 'Manage Accounts and Sign-in', 'Sign-up, sign-in, invitations, recovery, lockout, automatic sign-out'],
  ['2.0', 'Make and Change Bookings', 'Book, reschedule, cancel, add a service, walk-in, booking invitation'],
  ['3.0', 'Handle Payments and Refunds', 'Receipt reading, verification, balance, refunds'],
  ['4.0', 'Carry Out the Service', 'Assigned vehicles, start and finish, service photos, shifts'],
  ['5.0', 'Send Messages and Notices', 'Chat, in-app notices, emails'],
  ['6.0', 'Report and Audit', 'Dashboards, reports, daily report, audit log'],
  ['7.0', 'Manage Shop Rules', 'Hours, services, promos, closures, deposit rule'],
  ['8.0', 'Run Scheduled Checks', 'Release unpaid holds, flag no-shows, deactivate idle staff, clean up photos']
];
const stores = [
  ['D1', 'Accounts', 'profiles, roles, lockout state'],
  ['D2', 'Bookings', 'bookings, vehicles, services'],
  ['D3', 'Payments and Refunds', 'payments, balances, refunds'],
  ['D4', 'Service Photos', 'progress photos'],
  ['D5', 'Messages and Notices', 'chat, notifications'],
  ['D6', 'Audit Log', 'who did what and when'],
  ['D7', 'Shop Rules', 'hours, services, promos, closures'],
  ['D2', 'Bookings', 'bookings, vehicles, services']
];
// [entity, label out, label back]
const tags = [
  [['Customer', 'Sign-up and sign-in details / access'], ['Staff', 'Sign-in, password change / access'], ['Administrator', 'Invitations, staff accounts / confirmation']],
  [['Customer', 'Booking, change, and cancel requests / confirmations'], ['Administrator', 'Walk-in bookings / confirmations']],
  [['Customer', 'Receipts and references / payment status, refund receipt'], ['Administrator', 'Verification and refund decisions / queue']],
  [['Staff', 'Start, finish, photos / assigned tasks']],
  [['Customer', 'Chat messages / notices'], ['Staff', 'Chat messages / notices'], ['Administrator', 'Chat messages / notices'], ['Email Service', 'Emails / delivery results']],
  [['Administrator', 'Report requests / reports and logs']],
  [['Administrator', 'Settings, services, promos, closures / saved']],
  [['Scheduled time', 'Every 5 minutes and every 24 hours']]
];
const storeLabels = ['Accounts and roles', 'Bookings, vehicles, services', 'Payments, balances, refunds', 'Photos and progress', 'Messages and notices', 'Audit entries', 'Hours, services, promos, closures', 'Holds released, no-shows flagged'];

const dfd = () => {
  const W = 1320;
  const rowH = tags.map((t) => Math.max(132, t.length * 52 + 20));
  const total = rowH.reduce((a, b) => a + b, 0);
  const H = 90 + total + 70;
  const p = [title(W, 'Data Flow Diagram (Level 1): Core Operations (Logical)')];
  let y0 = 80;
  procs.forEach(([no, name, sub], i) => {
    const cy = y0 + rowH[i] / 2;
    const ph = rowH[i] - 24;
    p.push(`<rect x="400" y="${cy - ph / 2}" width="290" height="${ph}" rx="16" fill="#fff" stroke="#111" stroke-width="2"/>`);
    p.push(`<line x1="400" y1="${cy - ph / 2 + 26}" x2="690" y2="${cy - ph / 2 + 26}" stroke="#111" stroke-width="1.3"/>`);
    p.push(`<text x="545" y="${cy - ph / 2 + 18}" text-anchor="middle" font-size="12.5" font-weight="800" fill="#111">${no}</text>`);
    p.push(txt(545, cy - 6, name, 28, 13, 800));
    p.push(txt(545, cy + 22, sub, 40, 10.5, 400));
    // entity tags
    const n = tags[i].length;
    tags[i].forEach(([ent, label], k) => {
      const ty = cy + (k - (n - 1) / 2) * 52;
      p.push(`<rect x="30" y="${ty - 17}" width="150" height="34" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
      p.push(`<text x="105" y="${ty + 5}" text-anchor="middle" font-size="12.5" font-weight="800" fill="#111">${esc(ent)}</text>`);
      if (ent === 'Scheduled time') p.push(arr([[180, ty], [400, ty]]) + lab(290, ty, label));
      else p.push(bi(180, ty, 400, label, [290, ty - 8]));
    });
    // store
    const sx = 980;
    p.push(`<rect x="${sx}" y="${cy - 36}" width="300" height="72" fill="#fff" stroke="#111" stroke-width="2"/>`);
    p.push(`<line x1="${sx + 40}" y1="${cy - 36}" x2="${sx + 40}" y2="${cy + 36}" stroke="#111" stroke-width="1.4"/>`);
    p.push(`<text x="${sx + 20}" y="${cy + 5}" text-anchor="middle" font-size="12.5" font-weight="800" fill="#111">${stores[i][0]}</text>`);
    p.push(txt(sx + 170, cy - 10, stores[i][1], 28, 13, 800));
    p.push(txt(sx + 170, cy + 16, stores[i][2], 40, 10.5, 400));
    p.push(i === 7 ? arr([[690, cy], [sx, cy]]) + lab(835, cy, storeLabels[i]) : bi(690, cy, sx, storeLabels[i], [835, cy - 8]));
    y0 += rowH[i];
  });
  p.push(txt(30, H - 30, "Key: rectangle = external entity (repeated beside each process it talks to); rounded box = process; box with D = data store; two-way arrow = data goes one way and the answer comes back. The matrix shows exactly what each process reads and changes.", 190, 11.5, 400, "start"));
  return svgWrap(W, H, p.join('\n'));
};

// ───────────────────────── matrices ─────────────────────────
const matrix = () => {
  const W = 1500;
  const p = [title(W, 'Logical Data Flow Matrix')];
  const procShort = procs.map(([no, name]) => `${no} ${name}`);
  // table 1: process x data store (C create, R read, U update, D delete)
  const crud = [
    ['R U C', 'C R U', '', '', 'C', 'C', 'R', ''],
    ['', '', '', '', '', '', '', ''],
  ];
  // columns D1..D7; rows P1..P8
  const m = {
    '1.0': { D1: 'C R U', D5: 'C', D6: 'C' },
    '2.0': { D1: 'R', D2: 'C R U', D3: 'C R', D5: 'C', D6: 'C', D7: 'R' },
    '3.0': { D1: 'R', D2: 'R U', D3: 'C R U', D5: 'C', D6: 'C', D7: 'R' },
    '4.0': { D1: 'R', D2: 'R U', D4: 'C R', D5: 'C', D6: 'C' },
    '5.0': { D1: 'R', D2: 'R', D5: 'C R U' },
    '6.0': { D1: 'R', D2: 'R', D3: 'R', D5: 'R', D6: 'R', D7: 'R' },
    '7.0': { D7: 'C R U D' },
    '8.0': { D1: 'U', D2: 'U', D4: 'D', D5: 'C', D6: 'C', D7: 'R' }
  };
  const cols = [['D1', 'Accounts'], ['D2', 'Bookings'], ['D3', 'Payments and Refunds'], ['D4', 'Service Photos'], ['D5', 'Messages and Notices'], ['D6', 'Audit Log'], ['D7', 'Shop Rules']];
  const x0 = 40, labelW = 330, cw = 150, rh = 40, hh = 58;
  let y = 70;
  p.push(`<text x="${x0}" y="${y + 10}" font-size="15" font-weight="800" fill="#111">Table 1. What each process does with each data store</text>`);
  y += 28;
  p.push(`<rect x="${x0}" y="${y}" width="${labelW + cw * cols.length}" height="${hh}" fill="#111"/>`);
  p.push(`<text x="${x0 + 12}" y="${y + 34}" font-size="13" font-weight="800" fill="#fff">Process</text>`);
  cols.forEach(([d, name], i) => {
    p.push(txt(x0 + labelW + cw * i + cw / 2, y + 22, d, 10, 13, 800, 'middle', '#fff'));
    p.push(txt(x0 + labelW + cw * i + cw / 2, y + 42, name, 20, 10.5, 400, 'middle', '#fff'));
  });
  y += hh;
  procs.forEach(([no, name], r) => {
    p.push(`<rect x="${x0}" y="${y}" width="${labelW + cw * cols.length}" height="${rh}" fill="${r % 2 ? '#f2f2f2' : '#fff'}" stroke="#bbb"/>`);
    p.push(`<text x="${x0 + 12}" y="${y + 25}" font-size="12.5" font-weight="700" fill="#111">${esc(`${no}  ${name}`)}</text>`);
    cols.forEach(([d], i) => {
      const v = (m[no] || {})[d] || '';
      p.push(`<text x="${x0 + labelW + cw * i + cw / 2}" y="${y + 25}" text-anchor="middle" font-size="13" font-weight="800" fill="#111">${v}</text>`);
    });
    y += rh;
  });
  p.push(`<text x="${x0}" y="${y + 22}" font-size="11.5" fill="#111">C = creates, R = reads, U = updates, D = deletes. Services are only archived, never deleted. Process 8.0 (D4) removes old photos by the retention policy.</text>`);
  y += 56;

  // table 2: entity x process (I = sends data in, O = receives data out)
  p.push(`<text x="${x0}" y="${y + 10}" font-size="15" font-weight="800" fill="#111">Table 2. Which outside party sends data to, and receives data from, each process</text>`);
  y += 28;
  const ents = [
    ['Customer', { '1.0': 'I O', '2.0': 'I O', '3.0': 'I O', '5.0': 'I O' }],
    ['Staff', { '1.0': 'I O', '4.0': 'I O', '5.0': 'I O' }],
    ['Administrator', { '1.0': 'I O', '2.0': 'I O', '3.0': 'I O', '5.0': 'I O', '6.0': 'I O', '7.0': 'I O' }],
    ['Email Service', { '5.0': 'I O' }],
    ['Scheduled time', { '8.0': 'I' }]
  ];
  const cw2 = 130, lw2 = 190;
  p.push(`<rect x="${x0}" y="${y}" width="${lw2 + cw2 * procs.length}" height="64" fill="#111"/>`);
  p.push(`<text x="${x0 + 12}" y="${y + 38}" font-size="13" font-weight="800" fill="#fff">Outside party</text>`);
  procs.forEach(([no, name], i) => {
    p.push(txt(x0 + lw2 + cw2 * i + cw2 / 2, y + 20, no, 10, 13, 800, 'middle', '#fff'));
    p.push(txt(x0 + lw2 + cw2 * i + cw2 / 2, y + 44, name, 19, 10, 400, 'middle', '#fff'));
  });
  y += 64;
  ents.forEach(([name, v], r) => {
    p.push(`<rect x="${x0}" y="${y}" width="${lw2 + cw2 * procs.length}" height="${rh}" fill="${r % 2 ? '#f2f2f2' : '#fff'}" stroke="#bbb"/>`);
    p.push(`<text x="${x0 + 12}" y="${y + 25}" font-size="12.5" font-weight="700" fill="#111">${esc(name)}</text>`);
    procs.forEach(([no], i) => {
      p.push(`<text x="${x0 + lw2 + cw2 * i + cw2 / 2}" y="${y + 25}" text-anchor="middle" font-size="13" font-weight="800" fill="#111">${v[no] || ''}</text>`);
    });
    y += rh;
  });
  p.push(`<text x="${x0}" y="${y + 22}" font-size="11.5" fill="#111">I = sends data into the process (a request, a form, a receipt). O = receives data out of it (a result, a notice, an email). The email service also reports delivery results back.</text>`);
  y += 60;
  return svgWrap(W, y, p.join('\n'));
};

(async () => { await save(__dirname, { 'dfd-level1-operations': dfd(), 'data-flow-matrix': matrix() }); })();
