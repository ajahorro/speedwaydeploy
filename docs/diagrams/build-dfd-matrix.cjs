// DFD logical data flow matrix: four columns of processes grouped by function, with data stores and outside parties.
// Run: node docs/diagrams/build-dfd-matrix.cjs
const { txt, svgWrap, arr, save, esc } = require('./lib.cjs');

const W = 1575, H = 835;
const p = [];
const CX = [350, 630, 910, 1190];
const ROW = [235, 410, 575];
const SROW = [310, 485, 650];

const proc = (cx, cy, id, name) => {
  p.push(`<rect x="${cx - 85}" y="${cy - 36}" width="170" height="72" rx="12" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
  p.push(`<line x1="${cx - 85}" y1="${cy - 16}" x2="${cx + 85}" y2="${cy - 16}" stroke="#111" stroke-width="1.2"/>`);
  p.push(`<text x="${cx}" y="${cy - 22}" text-anchor="middle" font-size="11" font-weight="800" fill="#111">${id}</text>`);
  p.push(txt(cx, cy + 10, name, 26, 11.5, 700));
};
const store = (cx, cy, w, id, name) => {
  const idW = id.length > 5 ? 66 : id.length > 2 ? 46 : 28;
  p.push('<rect x="' + (cx - w / 2) + '" y="' + (cy - 16) + '" width="' + w + '" height="32" fill="#fff" stroke="#111" stroke-width="1.5"/>');
  p.push('<line x1="' + (cx - w / 2 + idW) + '" y1="' + (cy - 16) + '" x2="' + (cx - w / 2 + idW) + '" y2="' + (cy + 16) + '" stroke="#111" stroke-width="1.2"/>');
  p.push('<text x="' + (cx - w / 2 + idW / 2) + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="10.5" font-weight="800" fill="#111">' + id + '</text>');
  p.push(txt(cx - w / 2 + idW + (w - idW) / 2, cy, name, Math.floor((w - idW - 6) / 5.6), 10, 600));
};
const lab = (x, y, t, max = 14, anchor = 'middle') => p.push(txt(x, y, t, max, 10.5, 700, anchor).replace('<text ', '<text stroke="#fff" stroke-width="3.5" paint-order="stroke" '));
const line = (pts, o = {}) => p.push(arr(pts, '', null, o));
const dot = (x, y) => p.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="#111"/>`);

// frame and title
p.push(`<rect x="205" y="55" width="1140" height="670" rx="6" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
p.push(txt(775, 78, 'COMAR GARAGE ONLINE APPOINTMENT AND SCHEDULING SYSTEM: DFD LOGICAL DATA FLOW MATRIX', 90, 14, 800));

// column panels
const cols = [
  ['COLUMN 1: BOOKING AND PAYMENT PIPELINE', '(Customer focus)'],
  ['COLUMN 2: OPERATIONAL SCHEDULING', '(Administrator focus)'],
  ['COLUMN 3: ADMIN AND REPORTING', '(Administrator focus)'],
  ['COLUMN 4: SERVICE EXECUTION', '(Staff / Mobile Hub)']
];
cols.forEach(([h, s], i) => {
  const x = 215 + i * 280;
  p.push(`<rect x="${x}" y="140" width="270" height="555" rx="8" fill="#f1f1f1" stroke="#bbb" stroke-width="1.2"/>`);
  p.push(txt(x + 135, 158, h, 26, 11, 800));
  p.push(txt(x + 135, 188, s, 30, 10.5, 400));
});
// the panels above were laid with a 280 pitch; the last column is shifted to hold the staff party
// administrator bar
p.push(`<rect x="490" y="98" width="560" height="34" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
p.push(`<text x="770" y="120" text-anchor="middle" font-size="13" font-weight="800" fill="#111">ADMINISTRATOR</text>`);

// processes
const P = [
  [['A1.1', 'Process Booking Request'], ['A1.2', 'Verify Payment (receipt reading and administrator check)'], ['A1.3', 'Track Progress and Manage Garage']],
  [['A2.1', 'Check Capacity and Shop Rules'], ['A2.2', 'Assign Technicians (per vehicle)'], ['A2.3', 'Handle Cancellations and Refunds']],
  [['A3.1', 'Manage Users (staff and customers)'], ['A3.2', 'Configure Shop Rules, Services, Promos'], ['A3.3', 'Generate Reports and Audit Log']],
  [['A4.1', 'Clock In and Out (shift status)'], ['A4.2', 'View Assigned Vehicles'], ['A4.3', 'Update Job Status (start, finish, photos)']]
];
P.forEach((col, c) => col.forEach(([id, name], r) => proc(CX[c], ROW[r], id, name)));

// data stores (per column and row)
store(320, SROW[0], 120, 'D2', 'Booking Records');
store(CX[0], SROW[1], 150, 'D3', 'Payment Records');
store(CX[0], SROW[2], 150, 'D6', 'Customer Garage');
store(CX[1], SROW[0], 150, 'D7', 'Shop Rules');
store(CX[1], SROW[1], 150, 'D2', 'Booking Records');
store(CX[1], SROW[2], 170, 'D2 D3', 'Bookings, Payments');
store(CX[2], SROW[0], 150, 'D1', 'User Accounts');
store(CX[2], SROW[1], 180, 'D5 D7', 'Services, Promos, Rules');
store(CX[2], SROW[2], 190, 'D2 D3 D4', 'Read for reports');
store(CX[3], SROW[0], 150, 'D8', 'Staff Availability');
store(CX[3], SROW[1], 150, 'D2', 'Booking Records');
store(CX[3], SROW[2], 170, 'D4', 'Service Status, Photos');

// process <-> store arrows (down = writes, up = reads)
const down = (cx, r, label) => { line([[cx, ROW[r] + 36], [cx, SROW[r] - 16]]); if (label) lab(cx + 8, (ROW[r] + 36 + SROW[r] - 16) / 2 + 3, label, 10, 'start'); };
const up = (cx, r, label) => { line([[cx, SROW[r] - 16], [cx, ROW[r] + 36]]); if (label) lab(cx + 8, (ROW[r] + 36 + SROW[r] - 16) / 2 + 3, label, 10, 'start'); };
down(320, 0, 'Stores');
down(CX[0], 1, 'Stores');
line([[CX[0] - 12, ROW[2] + 36], [CX[0] - 12, SROW[2] - 16]]); line([[CX[0] + 12, SROW[2] - 16], [CX[0] + 12, ROW[2] + 36]]);
up(CX[1], 0, 'Reads');
down(CX[1], 1, 'Stores');
down(CX[1], 2, 'Updates');
line([[CX[2] - 12, ROW[0] + 36], [CX[2] - 12, SROW[0] - 16]]); line([[CX[2] + 12, SROW[0] - 16], [CX[2] + 12, ROW[0] + 36]]);
down(CX[2], 1, 'Saves');
up(CX[2], 2, 'Reads');
line([[CX[3] - 12, ROW[0] + 36], [CX[3] - 12, SROW[0] - 16]]); line([[CX[3] + 12, SROW[0] - 16], [CX[3] + 12, ROW[0] + 36]]);
up(CX[3], 1, 'Reads');
down(CX[3], 2, 'Stores');

// A1.1 -> A1.2 booking reference (right of D2)
line([[410, ROW[0] + 36], [410, ROW[1] - 36]]);
lab(418, 345, 'Booking reference', 9, 'start');

// customer party (left)
const cust = [['Select Vehicle and Service', 'Customer'], ['Upload GCash or Bank Receipt', 'Receipt image'], ['Monitor Progress', 'Customer']];
p.push(`<rect x="15" y="145" width="150" height="48" fill="#e6e6e6" stroke="#111" stroke-width="1.8"/>`);
p.push(txt(90, 169, 'EXTERNAL ENTITY (CUSTOMER)', 20, 11, 800));
cust.forEach(([name, label], r) => {
  p.push(`<rect x="15" y="${ROW[r] - 30}" width="150" height="60" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
  p.push(txt(90, ROW[r], name, 18, 12, 800));
  if (r === 2) { line([[165, ROW[r]], [263, ROW[r]]]); line([[263, ROW[r] + 14], [165, ROW[r] + 14]], {}); lab(214, ROW[r] - 8, 'Customer', 12); }
  else { line([[165, ROW[r]], [263, ROW[r]]]); lab(214, ROW[r] - 8, label, 14); }
});
line([[263, ROW[0] + 14], [165, ROW[0] + 14]]);
lab(214, ROW[0] + 30, 'Confirmation', 16);
line([[263, ROW[1] + 14], [165, ROW[1] + 14]]);
lab(214, ROW[1] + 30, 'Payment status', 14);

// staff party (right)
const staff = [['Clock In or Out', 'Shift'], ['View Assigned Vehicles', 'Tasks'], ['Start, Finish, Upload Photos', 'Updates']];
p.push(`<rect x="1385" y="145" width="170" height="48" fill="#e6e6e6" stroke="#111" stroke-width="1.8"/>`);
p.push(txt(1470, 169, 'EXTERNAL ENTITY (STAFF)', 20, 11, 800));
staff.forEach(([name, label], r) => {
  p.push(`<rect x="1395" y="${ROW[r] - 30}" width="160" height="60" fill="#fff" stroke="#111" stroke-width="1.8"/>`);
  p.push(txt(1475, ROW[r], name, 20, 12, 800));
  line([[1395, ROW[r]], [CX[3] + 87, ROW[r]]]);
  line([[CX[3] + 87, ROW[r] + 14], [1395, ROW[r] + 14]]);
  lab(1345, ROW[r] - 8, label, 12);
});

// A1.1 <-> A2.1 slot check
line([[435, ROW[0] - 8], [543, ROW[0] - 8]]);
line([[543, ROW[0] + 12], [435, ROW[0] + 12]]);
lab(489, ROW[0] - 17, 'Slot check', 12);
lab(489, ROW[0] + 28, 'Open or full', 12);

// administrator buses
line([[490, 132], [490, ROW[1]], [437, ROW[1]]]);
dot(490, 132);
line([[520, 132], [520, ROW[2]]], { noHead: true });
line([[520, ROW[1]], [543, ROW[1]]]);
line([[520, ROW[2]], [543, ROW[2]]]);
dot(520, 132);
line([[985, 132], [985, ROW[0] - 36]]);
line([[1050, 132], [1050, ROW[2]]], { noHead: true });
dot(1050, 132);
line([[1050, ROW[1]], [CX[2] + 87, ROW[1]]]);
line([[1050, ROW[2] - 8], [CX[2] + 87, ROW[2] - 8]]);
line([[CX[2] + 87, ROW[2] + 10], [1050, ROW[2] + 10]]);
lab(1030, ROW[2] + 26, 'Reports', 10, 'end');


// A2.2 -> A4.2 assignment notification
line([[CX[1] + 85, ROW[1]], [740, ROW[1]], [740, 350], [CX[3] - 40, 350], [CX[3] - 40, ROW[1] - 36]]);
lab(890, 342, 'Assignment notification', 40);

// live status (A4.3 / D4 -> A1.3)
line([[CX[3], SROW[2] + 16], [CX[3], 705], [228, 705], [228, ROW[2] + 20], [263, ROW[2] + 20]], { dashed: true });
lab(700, 698, 'Live status shown to the customer', 40);

// outside the frame: key
p.push(txt(20, 760, 'Key: rounded box = process; box with D = data store; rectangle = outside party. A solid arrow down from a process writes to the store; an arrow up reads from it. The administrator performs the steps shown by the arrows from the ADMINISTRATOR bar (verify payments, assign technicians, decide refunds, manage users, configure rules, read reports).', 190, 11, 400, 'start'));
p.push(txt(20, 805, 'Stores: D1 User Accounts, D2 Booking Records, D3 Payment Records, D4 Service Status and Photos, D5 Services and Promos, D6 Customer Garage, D7 Shop Rules, D8 Staff Availability.', 190, 11, 400, 'start'));

(async () => { await save(__dirname, { 'dfd-logical-data-flow-matrix': svgWrap(W, H, p.join('\n')) }); })();
