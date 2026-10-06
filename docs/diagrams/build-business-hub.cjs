// Business Hub module map: what the administrator can configure, where it is saved, and what it changes.
// Run: node docs/diagrams/build-business-hub.cjs
const { wrap, txt, svgWrap, title, arr, save, esc } = require('./lib.cjs');

const W = 1560, H = 820;
const p = [title(W, 'Business Hub (Administrator): Module Map and Effects')];
const colW = 240, gap = 14, x0 = 25;
const cx = (i) => x0 + colW / 2 + i * (colW + gap);

// top bar
p.push(`<rect x="${x0}" y="55" width="1510" height="40" rx="8" fill="#111"/>`);
p.push(`<text x="${W / 2}" y="81" text-anchor="middle" font-size="15" font-weight="800" fill="#fff">BUSINESS HUB: six sections, all saved to one shared set of shop rules</text>`);

const tabs = [
  ['1. Business Profile', ['Store name, contact number, email, and address', 'Payment and settlement details: QR code, account name, and account number', 'FAQ management: add, edit, reorder']],
  ['2. Schedule Rules', ['Opening and closing hours, or open 24/7', 'Closed weekdays', 'Minimum notice before booking, and how far ahead customers can book', 'Total bays, and vehicles per technician', 'Closures: a whole day, several days, or specific hours']],
  ['3. Service Catalog', ['Add a service: name, general service, vehicle category, price, and duration', 'Edit a service', 'Archive or restore a service (never deleted)', 'Vehicle category names']],
  ['4. Promo Management', ['Standard promo and package promo (fixed bundle price)', 'Valid dates, and the vehicles and services it applies to', 'Promo codes: applies to, start and end, usage limit']],
  ['5. Payment Policy', ['Downpayment allowed from this total amount', 'Standard downpayment rate', 'Higher rate from a larger total', 'Higher downpayment rate']],
  ['6. Terms', ['One text for each role: customer, staff, administrator', 'Publishing a changed text asks everyone in that role to accept it again']]
];
tabs.forEach(([head, items], i) => {
  const x = cx(i) - colW / 2; const y = 125; const h = 235;
  p.push(`<line x1="${cx(i)}" y1="95" x2="${cx(i)}" y2="${y}" stroke="#111" stroke-width="1.4"/>`);
  p.push(`<rect x="${x}" y="${y}" width="${colW}" height="${h}" rx="10" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
  p.push(`<rect x="${x}" y="${y}" width="${colW}" height="32" rx="10" fill="#e6e6e6" stroke="#111" stroke-width="1.8"/>`);
  p.push(txt(cx(i), y + 21, head, 26, 13, 800));
  let ty = y + 58;
  items.forEach((it) => {
    const ls = wrap(it, 33);
    p.push(`<text font-size="11.5" fill="#111"><tspan x="${x + 12}" y="${ty}">•</tspan>${ls.map((l, k) => `<tspan x="${x + 24}" y="${ty + k * 14}">${esc(l)}</tspan>`).join('')}</text>`);
    ty += ls.length * 14 + 10;
  });
  p.push(arr([[cx(i), y + h], [cx(i), 410]], '', null, {}));
});

// shared store
p.push(`<rect x="${x0}" y="410" width="1510" height="82" rx="10" fill="#f1f1f1" stroke="#111" stroke-width="2"/>`);
p.push(txt(W / 2, 434, 'SAVED SHOP RULES (read by every part of the system)', 80, 14, 800));
p.push(txt(W / 2, 463, 'One shared record holds the business details, hours and capacity, services and vehicle categories, promos, downpayment policy, terms, and FAQs. Closure times and promo codes are kept in their own lists.', 190, 11.5, 400));

// effects
const effects = [
  ['Customer booking', 'Which dates and times can be picked, and which services, prices, and promos are offered', 'Schedule Rules, Service Catalog, Promo Management'],
  ['Payments and receipts', 'The QR code and account shown to customers, the receipt check, and how much downpayment is required', 'Business Profile, Payment Policy'],
  ['Staff assignment', 'How many vehicles one technician can handle at the same time, and how many bays the shop has', 'Schedule Rules'],
  ['Administrator walk-ins', 'Follow the same hours, closures, and capacity, but skip the minimum notice', 'Schedule Rules'],
  ['Public information', 'Contact details, address, and FAQs shown on the storefront', 'Business Profile'],
  ['Terms acceptance', 'People in the changed role are asked to read and accept the new text again', 'Terms']
];
effects.forEach(([head, desc, uses], i) => {
  const x = cx(i) - colW / 2; const y = 560; const h = 175;
  p.push(arr([[cx(i), 492], [cx(i), y]], '', null, {}));
  p.push(`<rect x="${x}" y="${y}" width="${colW}" height="${h}" rx="10" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
  p.push(`<rect x="${x}" y="${y}" width="${colW}" height="32" rx="10" fill="#111"/>`);
  p.push(txt(cx(i), y + 21, head, 26, 13, 800, 'middle', '#fff'));
  p.push(txt(cx(i), y + 75, desc, 34, 11.5, 400));
  p.push(txt(cx(i), y + 138, 'Uses: ' + uses, 34, 10.5, 700, 'middle', '#111', true));
});
p.push(txt(x0, 765, 'Changes apply to new bookings. A booking that already exists keeps the price and promo it was made with. Services are archived, never deleted, so old bookings still show their service names.', 200, 11.5, 400, 'start'));
p.push(txt(x0, 790, 'Key: the top row is what the administrator can set; all six sections save into the same shop rules; the bottom row is where those rules take effect.', 200, 11.5, 400, 'start'));

(async () => { await save(__dirname, { 'business-hub-module-map': svgWrap(W, H, p.join('\n')) }); })();
