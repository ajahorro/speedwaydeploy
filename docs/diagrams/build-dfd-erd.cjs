// Builds the Level 1 data flow diagram (management and configuration) and the core-table ERD.
// Run: node docs/diagrams/build-dfd-erd.cjs   (black and white, prints well)
const fs = require('fs');
const path = require('path');
const sharp = require(path.join(__dirname, '../../backend/node_modules/sharp'));

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wrap = (text, max) => {
  const out = []; let line = '';
  for (const w of String(text).split(' ')) {
    if ((line + ' ' + w).trim().length > max) { out.push(line.trim()); line = w; } else line += ' ' + w;
  }
  if (line.trim()) out.push(line.trim());
  return out;
};
const lines = (x, y, label, max, size = 12, weight = 400, anchor = 'middle', fill = '#111') => {
  const ls = wrap(label, max);
  const y0 = y - ((ls.length - 1) * (size + 3)) / 2 + size / 3;
  return `<text text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}">${ls.map((l, i) => `<tspan x="${x}" y="${y0 + i * (size + 3)}">${esc(l)}</tspan>`).join('')}</text>`;
};
const svgWrap = (W, H, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#111"/></marker></defs>
<rect width="${W}" height="${H}" fill="#fff"/>
${body}
</svg>`;

// ───────────────────────── DFD level 1 ─────────────────────────
const dfd = () => {
  const W = 1560, H = 960;
  const p = [];
  p.push(`<text x="${W / 2}" y="30" text-anchor="middle" font-size="20" font-weight="800" fill="#111">Data Flow Diagram (Level 1): Management and Configuration</text>`);
  const xs = [220, 600, 980, 1360];
  const flow = (x1, y1, x2, y2, label, side = 'right', max = 22, dashed = false) => {
    p.push(`<path d="M${x1},${y1} L${x2},${y2}" stroke="#111" stroke-width="1.6" fill="none"${dashed ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#a)"/>`);
    const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;
    if (side === 'right') p.push(lines(mx + 8, my, label, max, 11.5, 600, 'start'));
    else p.push(lines(mx - 8, my, label, max, 11.5, 600, 'end'));
  };
  // external entity: administrator
  p.push(`<rect x="60" y="50" width="1440" height="64" fill="#fff" stroke="#111" stroke-width="2"/>`);
  p.push(`<text x="780" y="88" text-anchor="middle" font-size="15" font-weight="800" fill="#111">Administrator (Business Hub)</text>`);
  // processes 1-4
  const procs = [
    ['1.0', 'Manage Business Settings', 'Hours, closed days, notice, capacity, deposit rule, payment account'],
    ['2.0', 'Manage Services and Prices', 'Add, edit, or archive services; set prices and durations'],
    ['3.0', 'Manage Promotions', 'Create or end discounts for chosen vehicles and services'],
    ['4.0', 'Block Dates and Times', 'Close the shop for holidays, repairs, or special days']
  ];
  const inFlows = ['Business settings', 'Service and price changes', 'Promo details', 'Closure dates and times'];
  const outFlows = ['Saved settings', 'Saved services and prices', 'Saved promos', 'Saved closures'];
  const stores = [
    ['D1', 'Business Settings', 'hours, closed days, notice, capacity, deposit rule'],
    ['D2', 'Service Catalog', 'services, prices, durations, archived list'],
    ['D3', 'Promotions', 'discounts, dates, vehicle types, services'],
    ['D4', 'Blocked Times', 'closed date, start and end time, reason']
  ];
  const toRules = ['Hours, notice, capacity, deposit rule', 'Current services, prices, durations', 'Active promos', 'Blocked times'];
  procs.forEach(([no, name, sub], i) => {
    const x = xs[i];
    // administrator -> process, and confirmation back
    flow(x - 40, 114, x - 40, 200, inFlows[i], 'left', 20);
    flow(x + 40, 200, x + 40, 114, 'Confirmation', 'right', 14, true);
    // process box
    p.push(`<rect x="${x - 135}" y="200" width="270" height="112" rx="18" fill="#fff" stroke="#111" stroke-width="2"/>`);
    p.push(`<line x1="${x - 135}" y1="228" x2="${x + 135}" y2="228" stroke="#111" stroke-width="1.4"/>`);
    p.push(`<text x="${x}" y="220" text-anchor="middle" font-size="13" font-weight="800" fill="#111">${no}</text>`);
    p.push(lines(x, 252, name, 28, 13.5, 800));
    p.push(lines(x, 288, sub, 38, 11, 400));
    // process -> store
    flow(x, 312, x, 410, outFlows[i], 'right', 22);
    // store (Yourdon style: id box + open-ended rectangle)
    p.push(`<rect x="${x - 135}" y="410" width="270" height="76" fill="#fff" stroke="#111" stroke-width="2"/>`);
    p.push(`<line x1="${x - 95}" y1="410" x2="${x - 95}" y2="486" stroke="#111" stroke-width="1.4"/>`);
    p.push(`<text x="${x - 115}" y="454" text-anchor="middle" font-size="13" font-weight="800" fill="#111">${stores[i][0]}</text>`);
    p.push(lines(x + 20, 434, stores[i][1], 22, 13, 800));
    p.push(lines(x + 20, 464, stores[i][2], 34, 10.5, 400));
    // store -> rules process
    flow(x, 486, x, 590, toRules[i], 'right', 22);
  });
  // process 5.0 (wide)
  p.push(`<rect x="80" y="590" width="1400" height="104" rx="18" fill="#fff" stroke="#111" stroke-width="2"/>`);
  p.push(`<line x1="80" y1="618" x2="1480" y2="618" stroke="#111" stroke-width="1.4"/>`);
  p.push(`<text x="780" y="610" text-anchor="middle" font-size="13" font-weight="800" fill="#111">5.0</text>`);
  p.push(`<text x="780" y="646" text-anchor="middle" font-size="14" font-weight="800" fill="#111">Apply Rules to Bookings</text>`);
  p.push(lines(780, 674, 'Shows only the times, services, prices, and promos that are currently allowed, and accepts or declines each booking request using the saved rules', 150, 11.5, 400));
  // D5 and customer
  flow(500, 694, 500, 794, 'New booking with its price and promo saved', 'left', 24);
  flow(640, 794, 640, 694, 'Existing bookings (to check room)', 'right', 22);
  p.push(`<rect x="365" y="794" width="270" height="76" fill="#fff" stroke="#111" stroke-width="2"/>`);
  p.push(`<line x1="405" y1="794" x2="405" y2="870" stroke="#111" stroke-width="1.4"/>`);
  p.push(`<text x="385" y="838" text-anchor="middle" font-size="13" font-weight="800" fill="#111">D5</text>`);
  p.push(lines(520, 818, 'Bookings', 22, 13, 800));
  p.push(lines(520, 848, 'schedule, services, price, promo, payments', 34, 10.5, 400));
  flow(1180, 794, 1180, 694, 'Booking request', 'left', 20);
  flow(1320, 694, 1320, 794, 'Open times, prices, promos; booking accepted or declined', 'right', 24);
  p.push(`<rect x="1140" y="794" width="360" height="76" fill="#fff" stroke="#111" stroke-width="2"/>`);
  p.push(lines(1320, 832, 'Customer (or administrator for a walk-in)', 34, 14, 800));
  // key
  p.push(`<text x="60" y="925" font-size="11.5" fill="#111">Key: plain rectangle = external entity; rounded box with a number = process; box with D = data store; dashed arrow = confirmation shown to the administrator. Saved changes in D1 to D4 are used for the next booking request.</text>`);
  return svgWrap(W, H, p.join('\n'));
};

// ───────────────────────── ERD ─────────────────────────
const ROW = 20, HEAD = 30;
const entity = (p, e) => {
  const h = HEAD + e.rows.length * ROW + 8;
  p.push(`<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${h}" fill="#fff" stroke="#111" stroke-width="2"/>`);
  p.push(`<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${HEAD}" fill="#111"/>`);
  p.push(`<text x="${e.x + e.w / 2}" y="${e.y + 20}" text-anchor="middle" font-size="13.5" font-weight="800" fill="#fff">${esc(e.name)}</text>`);
  e.rows.forEach(([key, name], i) => {
    const y = e.y + HEAD + 16 + i * ROW;
    p.push(`<text x="${e.x + 10}" y="${y}" font-size="11" font-weight="800" fill="#111">${key}</text>`);
    p.push(`<text x="${e.x + 40}" y="${y}" font-size="12" font-weight="${key === 'PK' ? 800 : 400}" fill="#111">${esc(name)}</text>`);
    if (i === 0 && e.rows.length > 1) p.push('');
  });
  p.push(`<line x1="${e.x}" y1="${e.y + HEAD + 24}" x2="${e.x + e.w}" y2="${e.y + HEAD + 24}" stroke="#bbb"/>`);
  return { ...e, h, r: e.x + e.w, b: e.y + h };
};
// crow's foot end marker; (x,y) on the box edge, (dx,dy) unit vector pointing away from the box
const mark = (p, x, y, dx, dy, kind) => {
  const px = -dy, py = dx;
  const at = (d, o = 0) => [x + dx * d + px * o, y + dy * d + py * o];
  const tick = (d) => { const [a, b] = at(d, -7); const [c, e] = at(d, 7); p.push(`<line x1="${a}" y1="${b}" x2="${c}" y2="${e}" stroke="#111" stroke-width="1.6"/>`); };
  const circle = (d) => { const [a, b] = at(d); p.push(`<circle cx="${a}" cy="${b}" r="5" fill="#fff" stroke="#111" stroke-width="1.5"/>`); };
  const crow = () => { const [a, b] = at(14); [-8, 0, 8].forEach((o) => { const [c, e] = at(0, o); p.push(`<line x1="${a}" y1="${b}" x2="${c}" y2="${e}" stroke="#111" stroke-width="1.6"/>`); }); };
  if (kind === 'one') { tick(12); tick(18); }
  if (kind === 'zeroone') { tick(12); circle(24); }
  if (kind === 'many') crow();
  if (kind === 'onemany') { crow(); tick(21); }
  if (kind === 'zeromany') { crow(); circle(25); }
};
const link = (p, pts, kindA, dirA, kindB, dirB, label, lab, dashed = false) => {
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  p.push(`<path d="${d}" fill="none" stroke="#111" stroke-width="1.6"${dashed ? ' stroke-dasharray="7 4"' : ''}/>`);
  mark(p, pts[0][0], pts[0][1], dirA[0], dirA[1], kindA);
  mark(p, pts[pts.length - 1][0], pts[pts.length - 1][1], dirB[0], dirB[1], kindB);
  if (label) p.push(`<text x="${lab[0]}" y="${lab[1]}" text-anchor="${lab[2] || 'middle'}" font-size="11.5" font-weight="700" fill="#111">${esc(label)}</text>`);
};

const erd = () => {
  const W = 1600, H = 1190;
  const p = [];
  p.push(`<text x="${W / 2}" y="32" text-anchor="middle" font-size="20" font-weight="800" fill="#111">Entity-Relationship Diagram: Core Tables</text>`);
  const profiles = entity(p, { name: 'profiles  (Users and Roles)', x: 40, y: 80, w: 290, rows: [['PK', 'id'], ['', 'email'], ['', 'full_name'], ['', 'role  (CUSTOMER, STAFF, ADMIN)'], ['', 'phone_number'], ['', 'is_active'], ['', 'hired_at'], ['', 'can_view_reports']] });
  const bookings = entity(p, { name: 'bookings', x: 500, y: 80, w: 330, rows: [['PK', 'id'], ['FK', 'customer_id  (empty for a guest)'], ['FK', 'staff_id  (lead technician)'], ['', 'start_datetime'], ['', 'end_datetime'], ['', 'status'], ['', 'total_amount'], ['', 'payment_status'], ['', 'promo_code'], ['', 'discount_amount_snapshot'], ['', 'is_walk_in'], ['', 'guest_name']] });
  const payments = entity(p, { name: 'payments', x: 1080, y: 80, w: 300, rows: [['PK', 'id'], ['FK', 'booking_id'], ['', 'amount'], ['', 'method'], ['', 'status'], ['', 'reference_number'], ['', 'verified_by'], ['', 'verified_at']] });
  const promo = entity(p, { name: 'promo_codes  (Promos and Discounts)', x: 1080, y: 320, w: 300, rows: [['PK', 'id'], ['', 'code'], ['', 'name'], ['', 'discount_type'], ['', 'discount_value'], ['', 'valid_until'], ['', 'is_active']] });
  const bveh = entity(p, { name: 'booking_vehicles', x: 500, y: 520, w: 330, rows: [['PK', 'id'], ['FK', 'booking_id'], ['FK', 'staff_id  (technician for this vehicle)'], ['', 'plate_number'], ['', 'vehicle_type'], ['', 'status'], ['', 'subtotal']] });
  const bvs = entity(p, { name: 'booking_vehicle_services  (Services)', x: 1080, y: 560, w: 300, rows: [['PK', 'id'], ['FK', 'booking_vehicle_id'], ['', 'service_id'], ['', 'service_name'], ['', 'price'], ['', 'duration_minutes']] });
  const cat = entity(p, { name: 'catalog_builtin_services', x: 1080, y: 830, w: 300, rows: [['PK', 'service_id'], ['', 'name'], ['', 'category'], ['', 'vehicle_key'], ['', 'price'], ['', 'duration_minutes']] });

  // shop schedule and rules group (no foreign keys; read when a time is chosen)
  p.push(`<rect x="360" y="790" width="660" height="290" rx="14" fill="none" stroke="#111" stroke-width="1.6" stroke-dasharray="7 4"/>`);
  p.push(`<text x="690" y="813" text-anchor="middle" font-size="12.5" font-weight="800" fill="#111">Schedules and shop rules (no foreign keys; read when a time is chosen)</text>`);
  entity(p, { name: 'business_config  (one row)', x: 380, y: 830, w: 360, rows: [['PK', 'id'], ['', 'opening_hour, closing_hour'], ['', 'closed_weekdays'], ['', 'booking_lead_time_minutes'], ['', 'max_advance_days'], ['', 'slots_per_hour'], ['', 'downpayment_min_total, rates'], ['', 'custom_services  (added services)'], ['', 'promo_rules  (promotions)']] });
  entity(p, { name: 'blocked_slots', x: 780, y: 830, w: 220, rows: [['PK', 'id'], ['', 'block_date'], ['', 'start_time'], ['', 'end_time'], ['', 'reason'], ['', 'created_by']] });

  // profiles -> bookings (customer) and (lead technician)
  link(p, [[profiles.r, 140], [bookings.x, 140]], 'zeroone', [1, 0], 'zeromany', [-1, 0], 'books (customer_id)', [(profiles.r + bookings.x) / 2, 130]);
  link(p, [[profiles.r, 200], [bookings.x, 200]], 'zeroone', [1, 0], 'zeromany', [-1, 0], 'leads (staff_id)', [(profiles.r + bookings.x) / 2, 190]);
  // profiles -> booking_vehicles (technician per vehicle)
  link(p, [[185, profiles.b], [185, 600], [bveh.x, 600]], 'zeroone', [0, 1], 'zeromany', [-1, 0], 'works on (staff_id)', [215, 590, 'start'], false);
  // bookings -> booking_vehicles
  link(p, [[665, bookings.b], [665, bveh.y]], 'one', [0, 1], 'onemany', [0, -1], 'contains', [680, (bookings.b + bveh.y) / 2 + 4, 'start'], false);
  // bookings -> payments
  link(p, [[bookings.r, 140], [payments.x, 140]], 'one', [1, 0], 'zeromany', [-1, 0], 'paid by', [(bookings.r + payments.x) / 2, 130]);
  // booking_vehicles -> booking_vehicle_services
  link(p, [[bveh.r, 640], [bvs.x, 640]], 'one', [1, 0], 'onemany', [-1, 0], 'includes', [(bveh.r + bvs.x) / 2, 630]);
  // bookings -> promo_codes (value copied, dashed)
  link(p, [[bookings.r, 340], [promo.x, 340]], 'zeromany', [1, 0], 'zeroone', [-1, 0], 'may use (promo_code)', [915, 330, 'start'], true);
  // booking_vehicle_services -> catalog (copied by value, dashed)
  link(p, [[1230, bvs.b], [1230, cat.y]], 'zeromany', [0, 1], 'zeroone', [0, -1], 'copied from (service_id)', [1242, (bvs.b + cat.y) / 2 + 4], true);
  // rules -> bookings (dashed arrow)
  p.push(`<path d="M905,790 L905,250 L830,250" fill="none" stroke="#111" stroke-width="1.6" stroke-dasharray="7 4" marker-end="url(#a)"/>`);
  p.push(`<text x="915" y="770" font-size="11.5" font-weight="700" fill="#111">limit when</text><text x="915" y="784" font-size="11.5" font-weight="700" fill="#111">bookings fit</text>`);

  // notes
  const notes = [
    'There is no separate roles table. The role is a column on profiles. Each profile shares its id with its sign-in account.',
    'A booking with no customer_id is a walk-in guest; the guest\'s details are kept on the booking.',
    'Built-in services are in catalog_builtin_services. Services the administrator adds are saved in business_config. A booking copies the name, price, and time, so later price changes never alter it.',
    'Promotions are saved in business_config. promo_codes holds code-based discounts.'
  ];
  p.push(`<rect x="40" y="720" width="290" height="380" rx="10" fill="none" stroke="#111" stroke-width="1.6"/>`);
  p.push(`<text x="185" y="745" text-anchor="middle" font-size="13" font-weight="800" fill="#111">Notes</text>`);
  let ny = 775;
  notes.forEach((n) => { const ls = wrap(n, 40); p.push(`<text font-size="11.5" fill="#111">${ls.map((l, i) => `<tspan x="52" y="${ny + i * 15}">${esc(l)}</tspan>`).join('')}</text>`); ny += ls.length * 15 + 14; });
  p.push(`<text x="40" y="1150" font-size="11.5" fill="#111">Key: PK = primary key, FK = foreign key. Solid line = linked by a foreign key. Dashed line = value copied or checked, with no database link. Bar = one, circle = optional, crow's foot = many.</text>`);
  return svgWrap(W, H, p.join('\n'));
};

(async () => {
  const out = { 'dfd-level1-management-config': dfd(), 'erd-core-tables': erd() };
  for (const [name, svg] of Object.entries(out)) {
    fs.writeFileSync(path.join(__dirname, `${name}.svg`), svg);
    await sharp(Buffer.from(svg), { density: 150 }).png().toFile(path.join(__dirname, `${name}.png`));
    console.log('built', name);
  }
})();
