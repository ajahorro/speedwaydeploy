// Builds the security and authentication flowcharts (SVG + PNG). Run: node docs/diagrams/build-flowcharts.cjs
// Black and white so they print well. Shapes: rounded = start/end, rectangle = step, diamond = decision.
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
const text = (cx, cy, label, max, size = 13, weight = 400) => {
  const lines = wrap(label, max);
  const y0 = cy - ((lines.length - 1) * (size + 3)) / 2 + size / 3;
  return `<text text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="#111">${lines.map((l, i) => `<tspan x="${cx}" y="${y0 + i * (size + 3)}">${esc(l)}</tspan>`).join('')}</text>`;
};

const SIZE = {
  start: { w: 250, h: 52, chars: 34 },
  end: { w: 250, h: 52, chars: 34 },
  step: { w: 250, h: 66, chars: 33 },
  decision: { w: 250, h: 104, chars: 24 },
  side: { w: 150, h: 92, chars: 20 }
};

const shape = (n) => {
  const { w, h, chars } = SIZE[n.type];
  const { x: cx, y: cy } = n;
  if (n.type === 'start' || n.type === 'end') return `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="#fff" stroke="#111" stroke-width="2"/>${text(cx, cy, n.label, chars, 13, 700)}`;
  if (n.type === 'decision') return `<polygon points="${cx},${cy - h / 2} ${cx + w / 2},${cy} ${cx},${cy + h / 2} ${cx - w / 2},${cy}" fill="#fff" stroke="#111" stroke-width="1.8"/>${text(cx, cy, n.label, chars, 12.5, 600)}`;
  if (n.type === 'side') return `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2.6}" fill="#fff" stroke="#111" stroke-width="1.6" stroke-dasharray="1 0"/>${text(cx, cy, n.label, chars, 11.5, 600)}`;
  return `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="6" fill="#fff" stroke="#111" stroke-width="1.6"/>${text(cx, cy, n.label, chars)}`;
};

const arrow = (pts, label, labelPos) => {
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  const lab = label ? `<text x="${labelPos[0]}" y="${labelPos[1]}" font-size="11.5" font-weight="700" fill="#111">${esc(label)}</text>` : '';
  return `<path d="${d}" fill="none" stroke="#111" stroke-width="1.5" marker-end="url(#a)"/>${lab}`;
};

const svgWrap = (W, H, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#111"/></marker></defs>
<rect width="${W}" height="${H}" fill="#fff"/>
${body}
</svg>`;

/** Lays a lane out top to bottom. Each step: {type, label, no?: 'label of the side box', noLabel?} */
const layLane = (laneX, startY, steps) => {
  const nodes = []; const sides = []; const links = [];
  let y = startY; let prev = null;
  steps.forEach((s) => {
    const h = SIZE[s.type].h;
    const cy = y + h / 2;
    const node = { ...s, x: laneX, y: cy };
    nodes.push(node);
    if (prev) {
      const lab = prev.yesLabel ? prev.yesLabel : '';
      links.push(arrow([[laneX, prev.y + SIZE[prev.type].h / 2], [laneX, cy - h / 2]], lab, [laneX + 8, prev.y + SIZE[prev.type].h / 2 + 18]));
    }
    if (s.type === 'decision' && s.no) {
      const sx = laneX + 125 + 30 + SIZE.side.w / 2;
      const side = { type: 'side', label: s.no, x: sx, y: cy };
      sides.push(side);
      links.push(arrow([[laneX + SIZE[s.type].w / 2, cy], [sx - SIZE.side.w / 2, cy]], s.noLabel || 'No', [laneX + 131, cy - 7]));
    }
    prev = { ...node, yesLabel: s.type === 'decision' ? (s.yesLabel || 'Yes') : '' };
    y += h + 38;
  });
  return { nodes, sides, links, endY: y - 38, last: nodes[nodes.length - 1] };
};

// ───────────────────────── Flowchart 1: account creation and invitation ─────────────────────────
const accountCreation = () => {
  const laneW = 480, top = 336, W = laneW * 3 + 40, left = 20;
  const cx = (i) => left + i * laneW + 150;
  const lanes = [
    { title: 'A. Customer signs up on their own', steps: [
      { type: 'step', label: 'Opens Register and enters name, email, mobile number, and password' },
      { type: 'step', label: 'System checks the email and mobile number formats, matching passwords, and a password of at least 6 characters' },
      { type: 'decision', label: 'Is the email already registered?', no: 'Stop: told to sign in or reset the password', noLabel: 'Yes', yesLabel: 'No' },
      { type: 'step', label: 'Account is created as a CUSTOMER and is not yet active; an activation link is emailed' },
      { type: 'decision', label: 'Is the activation link valid and unused?', no: 'Told the link expired; asks for a new one', noLabel: 'No', yesLabel: 'Yes' },
      { type: 'step', label: 'Email is confirmed, the session starts, and the customer profile is saved' },
      { type: 'step', label: 'Accepts the customer terms and conditions on first open' }
    ] },
    { title: 'B. Staff or administrator invited by an administrator', steps: [
      { type: 'step', label: 'Administrator enters the email, name, and role (Staff or Administrator) on Staff Roles' },
      { type: 'decision', label: 'Is the caller a signed-in, active administrator?', no: 'Refused', noLabel: 'No', yesLabel: 'Yes' },
      { type: 'decision', label: 'Does an account with this email already exist?', no: 'If a customer: role is raised and history kept. Otherwise refused', noLabel: 'Yes', yesLabel: 'No' },
      { type: 'step', label: 'Account is created, email already confirmed, with a random temporary password and a "must change password" flag' },
      { type: 'step', label: 'Invitation email with the login link and temporary password is sent; the action is written to the audit log' },
      { type: 'step', label: 'Invitee signs in and is forced to set their own password before anything else' },
      { type: 'step', label: 'Accepts the staff or administrator terms on first open' }
    ] },
    { title: 'C. Walk-in customer invited to register', steps: [
      { type: 'step', label: 'Administrator books a walk-in guest who gave an email address (no account yet)' },
      { type: 'step', label: 'System creates a one-time registration invite tied to that booking, valid 7 days, and emails the link' },
      { type: 'decision', label: 'Is the invite unused and not expired?', no: 'Normal sign-up form is shown instead', noLabel: 'No', yesLabel: 'Yes' },
      { type: 'step', label: 'Register form opens with the email filled in and locked; name and phone can be corrected' },
      { type: 'step', label: 'Guest sets a password and activates the account through the emailed link (as in A)' },
      { type: 'step', label: 'Invite is marked used and the guest\'s bookings are linked to the new customer account' },
      { type: 'step', label: 'Accepts the customer terms on first open' }
    ] }
  ];
  const parts = [];
  const laid = lanes.map((l, i) => ({ ...l, ...layLane(cx(i), top, l.steps), x: cx(i) }));
  const bottomY = Math.max(...laid.map((l) => l.endY)) + 70;
  const H = bottomY + 150;
  const midX = cx(1);
  const decY = 160;

  parts.push(`<text x="${W / 2}" y="32" text-anchor="middle" font-size="20" font-weight="800" fill="#111">Flowchart: Account Creation and Invitation Logic</text>`);
  parts.push(shape({ type: 'start', label: 'A person needs an account', x: midX, y: 76 }), shape({ type: 'decision', label: 'How is the account created?', x: midX, y: decY }));
  parts.push(arrow([[midX, 76 + 26], [midX, decY - 52]]));

  laid.forEach((l, i) => {
    const fx = left + i * laneW + 6;
    parts.push(`<rect x="${fx}" y="236" width="${laneW - 12}" height="${bottomY - 236}" rx="10" fill="none" stroke="#777" stroke-width="1.2" stroke-dasharray="6 5"/>`);
    // lane header box
    const headTop = 256, headH = 50;
    parts.push(`<rect x="${l.x - 145}" y="${headTop}" width="290" height="${headH}" rx="6" fill="#111"/>`);
    const lines = wrap(l.title, 36);
    parts.push(`<text text-anchor="middle" font-size="13" font-weight="800" fill="#fff">${lines.map((t, k) => `<tspan x="${l.x}" y="${headTop + headH / 2 + 4 - ((lines.length - 1) * 8) + k * 16}">${esc(t)}</tspan>`).join('')}</text>`);
    const first = l.nodes[0];
    const firstTop = first.y - SIZE[first.type].h / 2;
    parts.push(arrow([[l.x, headTop + headH], [l.x, firstTop]]));
    const labels = ['Signs up on their own', 'Invited by an administrator', 'Invited after a walk-in booking'];
    if (i === 0) parts.push(arrow([[midX - 125, decY], [l.x, decY], [l.x, headTop]], labels[0], [l.x + 10, decY - 8]));
    if (i === 1) parts.push(arrow([[midX, decY + 52], [midX, headTop]], labels[1], [midX + 10, decY + 74]));
    if (i === 2) parts.push(arrow([[midX + 125, decY], [l.x, decY], [l.x, headTop]], labels[2], [midX + 135, decY - 8]));
    parts.push(...l.links, ...l.nodes.map(shape), ...l.sides.map(shape));
    const last = l.last;
    parts.push(`<path d="M${l.x},${last.y + SIZE[last.type].h / 2} L${l.x},${bottomY - 20} L${midX},${bottomY - 20} L${midX},${bottomY + 18}" fill="none" stroke="#111" stroke-width="1.5" ${i === 1 ? 'marker-end="url(#a)"' : ''}/>`);
  });
  parts.push(shape({ type: 'end', label: 'Signed in: sent to the portal for their role', x: midX, y: bottomY + 44 }));
  parts.push(`<text x="${W / 2}" y="${bottomY + 100}" text-anchor="middle" font-size="12" fill="#333">Every sign-in then goes through the lockout check (see the Sign-In and Lockout flowchart). Staff and administrator accounts cannot be self-registered.</text>`);
  return svgWrap(W, H, parts.join('\n'));
};

// ───────────────────────── Flowchart 2: password recovery ─────────────────────────
const recovery = () => {
  const W = 1180, cx = 330;
  const steps = [
    { type: 'start', label: 'User forgets the password' },
    { type: 'step', label: 'Chooses "Forgot password?" and enters the account email' },
    { type: 'step', label: 'System always shows the same message: "If an account exists, a reset link was sent" (so nobody can test which emails exist)' },
    { type: 'decision', label: 'Does an active account with this email exist?', no: 'Nothing is sent', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'Earlier unused reset requests are cancelled; a new one-time token is made and only its hash is stored' },
    { type: 'step', label: 'Reset link with the token is emailed; it is valid for 15 minutes' },
    { type: 'step', label: 'User opens the link; the system checks the token' },
    { type: 'decision', label: 'Is the token genuine, unused, and not expired?', no: 'Told the link is expired or invalid; can request a new one', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'Set-new-password form: password of at least 6 characters, typed twice' },
    { type: 'step', label: 'Token is claimed in one step (marked used) so the link works only once, even if clicked twice' },
    { type: 'step', label: 'Password is updated in the sign-in service' },
    { type: 'step', label: 'Security email "your password was reset" is sent to the owner' },
    { type: 'end', label: 'User signs in with the new password' }
  ];
  const lane = layLane(cx, 90, steps);
  const H = lane.endY + 110;
  const parts = [];
  parts.push(`<text x="${W / 2}" y="32" text-anchor="middle" font-size="20" font-weight="800" fill="#111">Flowchart: Password Recovery (Forgot and Reset)</text>`);
  parts.push(...lane.links, ...lane.nodes.map(shape), ...lane.sides.map(shape));
  // second entry point: lockout escalation
  const note = { type: 'side', label: 'Also sent automatically after repeated wrong passwords (lockout notice)', x: 860, y: 190 };
  parts.push(`<rect x="715" y="150" width="290" height="84" rx="12" fill="#fff" stroke="#111" stroke-width="1.6"/>${text(860, 192, 'Second entry: after repeated wrong passwords the system emails a security notice with the same kind of reset link', 38, 12.5, 600)}`);
  const n6 = lane.nodes[5];
  parts.push(`<path d="M860,234 L860,${n6.y} L${cx + 125},${n6.y}" fill="none" stroke="#111" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#a)"/>`);
  parts.push(`<text x="${W - 40}" y="${H - 18}" text-anchor="end" font-size="11" fill="#555">The reset never reveals the old password and never signs the user in automatically.</text>`);
  return svgWrap(W, H, parts.join('\n'));
};


// ───────────────────────── Flowchart 3: sign-in and lockout ─────────────────────────
const signIn = () => {
  const W = 1240, cx = 330;
  const steps = [
    { type: 'start', label: 'User enters email and password' },
    { type: 'step', label: 'Email is cleaned up; both fields are required' },
    { type: 'decision', label: 'Is the account locked right now? (checked in the database)', no: 'Refused: shows the minutes left, or "check your email"', noLabel: 'Yes', yesLabel: 'No' },
    { type: 'step', label: 'Email and password are sent to the sign-in service' },
    { type: 'decision', label: 'Are the email and password correct?', no: 'Failure is recorded (see the ladder on the right)', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'The failure counter and any lock are cleared; the profile is loaded' },
    { type: 'decision', label: 'Is the account active?', no: 'Signed out (a self-deactivated account can be recovered within 15 days)', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'Password gate: an invited account must set its own new password first and cannot skip it' },
    { type: 'step', label: 'Terms gate: if the current terms for this role are not accepted, the user must scroll to the end and accept' },
    { type: 'step', label: 'Role check: Customer goes to the customer portal, Staff to the staff portal, Administrator to the admin portal' },
    { type: 'end', label: 'Signed in' }
  ];
  const lane = layLane(cx, 90, steps);
  const H = lane.endY + 110;
  const parts = [];
  parts.push(`<text x="${W / 2}" y="32" text-anchor="middle" font-size="20" font-weight="800" fill="#111">Flowchart: Sign-In and Account Lockout</text>`);
  parts.push(...lane.links, ...lane.nodes.map(shape), ...lane.sides.map(shape));

  // the lockout ladder panel, fed by the "wrong password" exit
  const px = 820, pw = 360, py = 330;
  const rows = [
    ['Wrong passwords 1 to 4', 'No lock. The screen says how many tries are left.'],
    ['5th wrong password', 'Locked for 5 minutes.'],
    ['6th wrong password', 'Allowed (a small fresh allowance after the wait).'],
    ['7th wrong password', 'Locked for 10 minutes.'],
    ['8th wrong password', 'Held for 60 minutes. A security notice with a password-reset link is emailed to the owner.']
  ];
  parts.push(`<rect x="${px}" y="${py - 40}" width="${pw}" height="${rows.length * 78 + 52}" rx="10" fill="none" stroke="#111" stroke-width="1.8"/>`);
  parts.push(`<rect x="${px}" y="${py - 40}" width="${pw}" height="34" rx="10" fill="#111"/>`);
  parts.push(`<text x="${px + pw / 2}" y="${py - 18}" text-anchor="middle" font-size="13" font-weight="800" fill="#fff">Lockout ladder (kept in the database)</text>`);
  rows.forEach(([head, body], i) => {
    const y = py + i * 78 + 8;
    parts.push(`<line x1="${px}" y1="${y - 6}" x2="${px + pw}" y2="${y - 6}" stroke="#bbb"/>`);
    parts.push(`<text x="${px + 14}" y="${y + 12}" font-size="12.5" font-weight="800" fill="#111">${esc(head)}</text>`);
    parts.push(`<text font-size="12" fill="#111">${wrap(body, 44).map((t, k) => `<tspan x="${px + 14}" y="${y + 32 + k * 15}">${esc(t)}</tspan>`).join('')}</text>`);
  });
  parts.push(`<text x="${px + pw / 2}" y="${py + rows.length * 78 + 24}" text-anchor="middle" font-size="11" fill="#444">An unknown email gets the same answer as a wrong password.</text>`);
  // arrow from the "No" side box of the credentials decision to the panel
  const credDecision = lane.nodes[4];
  const side = lane.sides.find((n) => n.y === credDecision.y);
  parts.push(`<path d="M${side.x + SIZE.side.w / 2},${side.y} L${px - 24},${side.y} L${px - 24},${py + 60} L${px},${py + 60}" fill="none" stroke="#111" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#a)"/>`);
  return svgWrap(W, H, parts.join('\n'));
};

// ───────────────────────── Flowchart 4: access control by role ─────────────────────────
const accessControl = () => {
  const W = 1240, cx = 330;
  const steps = [
    { type: 'start', label: 'A signed-in user opens a page or asks for data' },
    { type: 'decision', label: 'Layer 1, the screen: is there a valid session?', no: 'Sent to login, then back to the same page', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'decision', label: 'Does the user\'s role allow this page?', no: 'Sent to the home page', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'decision', label: 'Layer 2, the server: is the caller allowed this action?', no: 'Request refused (not authorised)', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'decision', label: 'Layer 3, the database: does row-level security allow these records?', no: 'Records hidden or change refused', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'Protected fields (role, joined date, report access) are administrator-only; the last administrator cannot be removed' },
    { type: 'step', label: 'Important administrator actions are written to the audit log' },
    { type: 'end', label: 'Request allowed' }
  ];
  const lane = layLane(cx, 90, steps);
  const H = lane.endY + 110;
  const parts = [];
  parts.push(`<text x="${W / 2}" y="32" text-anchor="middle" font-size="20" font-weight="800" fill="#111">Flowchart: Role-Based Access Control</text>`);
  parts.push(...lane.links, ...lane.nodes.map(shape), ...lane.sides.map(shape));

  // what each role can reach
  const px = 800, pw = 400, py = 250;
  const roles = [
    ['Customer', 'Own bookings, vehicles, payments, receipts, and chat only.'],
    ['Staff', 'Only the vehicles assigned to them: photos, notes, and start or finish. No payments, prices, refunds, or other accounts. Reports only if the administrator turns them on.'],
    ['Administrator', 'All bookings, payments, refunds, reports, accounts, settings, and the audit log.']
  ];
  parts.push(`<rect x="${px}" y="${py - 40}" width="${pw}" height="330" rx="10" fill="none" stroke="#111" stroke-width="1.8"/>`);
  parts.push(`<rect x="${px}" y="${py - 40}" width="${pw}" height="34" rx="10" fill="#111"/>`);
  parts.push(`<text x="${px + pw / 2}" y="${py - 18}" text-anchor="middle" font-size="13" font-weight="800" fill="#fff">What each role can reach</text>`);
  const heights = [78, 128, 84];
  let y = py + 6;
  roles.forEach(([head, body], i) => {
    parts.push(`<line x1="${px}" y1="${y - 6}" x2="${px + pw}" y2="${y - 6}" stroke="#bbb"/>`);
    parts.push(`<text x="${px + 14}" y="${y + 14}" font-size="13" font-weight="800" fill="#111">${esc(head)}</text>`);
    parts.push(`<text font-size="12" fill="#111">${wrap(body, 52).map((t, k) => `<tspan x="${px + 14}" y="${y + 34 + k * 15}">${esc(t)}</tspan>`).join('')}</text>`);
    y += heights[i];
  });
  // the watchdog note
  parts.push(`<rect x="${px}" y="${py + 320}" width="${pw}" height="104" rx="10" fill="#fff" stroke="#111" stroke-width="1.6" stroke-dasharray="6 4"/>`);
  parts.push(`<text x="${px + pw / 2}" y="${py + 344}" text-anchor="middle" font-size="13" font-weight="800" fill="#111">Access is re-checked while signed in</text>`);
  parts.push(`<text font-size="12" fill="#111">${wrap('Every minute, and each time the user returns to the tab, the system re-reads the role and active status. A changed role refreshes the session; a deactivated account is signed out at once.', 54).map((t, k) => `<tspan x="${px + 14}" y="${py + 366 + k * 15}">${esc(t)}</tspan>`).join('')}</text>`);
  return svgWrap(W, H, parts.join('\n'));
};


// ───────────────────────── Flowchart 5: automatic sign-out after inactivity ─────────────────────────
const idleLogout = () => {
  const W = 1240, cx = 330;
  const steps = [
    { type: 'start', label: 'A user is signed in and using the system' },
    { type: 'step', label: 'Every click, key press, scroll, or touch updates a shared "last activity" time (all open tabs of the browser share it)' },
    { type: 'decision', label: 'Idle for the limit minus 60 seconds? (checked every second)', no: 'Keep working. The check repeats', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'A warning appears with a 60-second countdown. Clicks elsewhere on the page do not count now' },
    { type: 'decision', label: 'Does the user press "Stay signed in" before the countdown ends?', yesLabel: 'No: the countdown ends, or "Sign out now"' },
    { type: 'step', label: 'For administrator and staff accounts, the automatic sign-out is first written to the audit log' },
    { type: 'step', label: 'The session is ended in the sign-in service, so every open tab is signed out' },
    { type: 'step', label: 'The login page opens with the message: "You were signed out because there was no activity"' },
    { type: 'end', label: 'The user signs in again; a fresh idle period starts' }
  ];
  const lane = layLane(cx, 90, steps);
  const H = Math.max(lane.endY + 110, 900);
  const parts = [];
  parts.push(`<text x="${W / 2}" y="32" text-anchor="middle" font-size="20" font-weight="800" fill="#111">Flowchart: Automatic Sign-Out After Inactivity</text>`);
  parts.push(...lane.links, ...lane.nodes.map(shape), ...lane.sides.map(shape));

  // "Stay signed in" returns to normal use: loop arrow from the Yes branch back up to the activity step
  const stay = lane.nodes[4];
  const activity = lane.nodes[1];
  const loopX = cx - 125 - 70;
  parts.push(`<path d="M${cx - 125},${stay.y} L${loopX},${stay.y} L${loopX},${activity.y} L${cx - 125},${activity.y}" fill="none" stroke="#111" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#a)"/>`);
  parts.push(`<text x="${loopX - 6}" y="${(stay.y + activity.y) / 2}" text-anchor="end" font-size="11.5" font-weight="700" fill="#111" transform="rotate(-90 ${loopX - 6} ${(stay.y + activity.y) / 2})">Yes: idle time resets, the warning closes</text>`);

  // limits and rules panel
  const px = 800, pw = 400, py = 130;
  const rows = [
    ['Idle limits', 'Every role (administrator, staff, and customer) is signed out after 60 minutes without activity. The limit is set in one place and can be changed.'],
    ['Several tabs', 'Activity in any tab keeps every tab signed in. If another tab presses "Stay signed in", this tab\'s warning closes.'],
    ['Reopened browser', 'If the limit has already passed (for example the computer was asleep or closed), the user is signed out at once, with no warning.'],
    ['Nothing is lost', 'Booking forms are saved as they are typed, so the draft is there after signing in again.']
  ];
  const heights = [96, 110, 110, 80];
  const total = heights.reduce((a, b) => a + b, 0) + 52;
  parts.push(`<rect x="${px}" y="${py - 40}" width="${pw}" height="${total}" rx="10" fill="none" stroke="#111" stroke-width="1.8"/>`);
  parts.push(`<rect x="${px}" y="${py - 40}" width="${pw}" height="34" rx="10" fill="#111"/>`);
  parts.push(`<text x="${px + pw / 2}" y="${py - 18}" text-anchor="middle" font-size="13" font-weight="800" fill="#fff">Rules</text>`);
  let y = py + 6;
  rows.forEach(([head, body], i) => {
    parts.push(`<line x1="${px}" y1="${y - 6}" x2="${px + pw}" y2="${y - 6}" stroke="#bbb"/>`);
    parts.push(`<text x="${px + 14}" y="${y + 14}" font-size="13" font-weight="800" fill="#111">${esc(head)}</text>`);
    parts.push(`<text font-size="12" fill="#111">${wrap(body, 52).map((t, k) => `<tspan x="${px + 14}" y="${y + 34 + k * 15}">${esc(t)}</tspan>`).join('')}</text>`);
    y += heights[i];
  });
  return svgWrap(W, H, parts.join('\n'));
};


// ───────────────────────── Flowchart 6: customer booking flow ─────────────────────────
const bookingFlow = () => {
  const laneW = 480, left = 20, W = laneW * 4 + 40, top = 176;
  const cx = (i) => left + i * laneW + 150;
  const A = [
    { type: 'start', label: 'Customer opens Book Appointment' },
    { type: 'step', label: 'For each vehicle: choose a saved vehicle, or enter its type, brand, model, and plate' },
    { type: 'step', label: 'Choose services for each vehicle; prices follow the vehicle type' },
    { type: 'decision', label: 'Does each vehicle have services and its own plate?', no: 'Fix the highlighted item (for example a missing required service)', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'Eligible promotions apply on their own; the customer may also enter a promo code (see the panel)', promo: true },
    { type: 'step', label: 'Customer picks a date' },
    { type: 'decision', label: 'Is the date open? (not closed, blocked, past, or too far ahead)', no: 'Date is greyed out with the reason; pick another', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'System lists the times that fit the longest job plus a buffer, the bays needed, the free technicians, and the shop hours' },
    { type: 'decision', label: 'Is any time slot free on that day?', no: 'Told there is no space; choose another date', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'Customer picks a time; the list refreshes live if someone else takes it' }
  ];
  const P = [
    { type: 'step', label: 'Customer types a promo code' },
    { type: 'decision', label: 'Does the server accept the code now?', no: 'Message says why (not found, not started, expired, used up, or sign in); no discount', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'The promotion the code unlocks is added to the matching services or package' },
    { type: 'end', label: 'Totals update; the customer continues in Step 1' }
  ];
  const B = [
    { type: 'step', label: 'Step 3, fleet review: check, edit, add (if bays allow), or remove vehicles; totals update' },
    { type: 'step', label: 'Step 4: review schedule, services, discount, and total; accept the terms if not yet accepted' },
    { type: 'decision', label: 'Pay in cash? (offered only when the total is under \u20B11,000)', no: 'Booking is unpaid until paid at the shop; no receipt needed', noLabel: 'Yes', yesLabel: 'No', cash: true },
    { type: 'step', label: 'Digital payment: choose Full or the downpayment (the minimum follows the shop\'s rule)' },
    { type: 'step', label: 'Pay with the shop QR code, then upload the receipt photo' },
    { type: 'step', label: 'The receipt is read: amount, reference number, recipient, and transfer fee' },
    { type: 'decision', label: 'Is the receipt real, for enough, and not used before?', no: 'Blocked with the reason; upload a correct receipt', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'Customer presses Submit (only one submission can run at a time)' }
  ];
  const C = [
    { type: 'step', label: 'The server re-checks the date, time, shop capacity, and every price' },
    { type: 'decision', label: 'Is everything still valid?', no: 'Guided message (for example the slot was just taken); back to the schedule step', noLabel: 'No', yesLabel: 'Yes' },
    { type: 'step', label: 'The booking is saved in one all-or-nothing step: vehicles, services, total, discount, and payment record' },
    { type: 'step', label: 'Status is Scheduled. A digital payment waits for verification; a cash booking is marked unpaid' },
    { type: 'step', label: 'Success page and confirmation email for the customer; administrators are notified' },
    { type: 'end', label: 'Once the payment is verified and a technician is assigned, the booking is Confirmed' }
  ];

  const laneA = layLane(cx(0), top, A);
  const promoIdx = A.findIndex((n) => n.promo);
  const promoNode = laneA.nodes[promoIdx];
  const laneP = layLane(cx(1), promoNode.y - SIZE.step.h / 2, P);
  const laneB = layLane(cx(2), top, B);
  const laneC = layLane(cx(3), top, C);
  const lanes = [
    { title: 'Steps 1 and 2: Services, vehicles, and schedule', lane: laneA },
    { title: 'Promo code (optional, in Step 1)', lane: laneP },
    { title: 'Steps 3 and 4: Review and pay', lane: laneB },
    { title: 'Submit and confirmation', lane: laneC }
  ];
  const bottomY = Math.max(...lanes.map((l) => l.lane.endY)) + 80;
  const H = bottomY + 70;
  const parts = [];
  parts.push(`<text x="${W / 2}" y="32" text-anchor="middle" font-size="22" font-weight="800" fill="#111">Flowchart: Customer Booking Flow</text>`);
  parts.push(`<text x="${W / 2}" y="56" text-anchor="middle" font-size="13" fill="#444">From choosing services to a saved booking. A saved draft or Book Again details can pre-fill the first steps; administrator walk-in bookings follow the same steps but are confirmed at once and take payment at the desk</text>`);

  lanes.forEach(({ title, lane }, i) => {
    const x = cx(i);
    const fx = left + i * laneW + 6;
    parts.push(`<rect x="${fx}" y="84" width="${laneW - 12}" height="${bottomY - 84}" rx="10" fill="none" stroke="#777" stroke-width="1.2" stroke-dasharray="6 5"/>`);
    const headTop = 98, headH = 50;
    parts.push(`<rect x="${x - 145}" y="${headTop}" width="290" height="${headH}" rx="6" fill="#111"/>`);
    const lines = wrap(title, 36);
    parts.push(`<text text-anchor="middle" font-size="13" font-weight="800" fill="#fff">${lines.map((t, k) => `<tspan x="${x}" y="${headTop + headH / 2 + 4 - ((lines.length - 1) * 8) + k * 16}">${esc(t)}</tspan>`).join('')}</text>`);
    if (i !== 1) {
      const first = lane.nodes[0];
      parts.push(arrow([[x, headTop + headH], [x, first.y - SIZE[first.type].h / 2]]));
    }
    parts.push(...lane.links, ...lane.nodes.map(shape), ...lane.sides.map(shape));
  });

  // optional promo code: from the promotions step into the panel
  parts.push(arrow([[cx(0) + 125, promoNode.y], [cx(1) - 125, promoNode.y]], 'optional', [cx(0) + 150, promoNode.y - 8]));
  // header of the promo panel notes it is a sub-flow (no incoming arrow from the header)

  // route from the end of one lane to the header of a later lane, along the frame gap and above the frames
  const route = (fromLane, fromIdx, toIdx, gapOffset = -8) => {
    const last = fromLane.last;
    const xFrom = cx(fromIdx);
    const gapX = left + (fromIdx + 1) * laneW + gapOffset;
    const yJoin = bottomY - 24 + (fromIdx === 0 ? 0 : 10);
    return arrow([[xFrom, last.y + SIZE[last.type].h / 2], [xFrom, yJoin], [gapX, yJoin], [gapX, 72], [cx(toIdx), 72], [cx(toIdx), 98]]);
  };
  parts.push(route(laneA, 0, 2));
  parts.push(route(laneB, 2, 3));

  // cash path: from its side box to the first step of the submit lane
  const cashDecision = laneB.nodes[B.findIndex((n) => n.cash)];
  const cashSide = laneB.sides.find((n) => n.y === cashDecision.y);
  const gapBC = left + 3 * laneW;
  const firstC = laneC.nodes[0];
  parts.push(`<path d="M${cashSide.x + SIZE.side.w / 2},${cashSide.y} L${gapBC + 10},${cashSide.y} L${gapBC + 10},${firstC.y} L${cx(3) - 125},${firstC.y}" fill="none" stroke="#111" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#a)"/>`);

  // note about unreadable receipts
  const readStep = laneB.nodes[B.findIndex((n) => /receipt is read/.test(n.label))];
  const noteX = cx(2) + 125 + 30 + 75;
  parts.push(`<rect x="${noteX - 75}" y="${readStep.y - 46}" width="150" height="92" rx="14" fill="#fff" stroke="#111" stroke-width="1.3" stroke-dasharray="6 4"/>`);
  parts.push(text(noteX, readStep.y, 'If the text cannot be read at all, the receipt is accepted for the administrator to check by hand', 20, 11, 600));
  parts.push(`<path d="M${cx(2) + 125},${readStep.y} L${noteX - 75},${readStep.y}" fill="none" stroke="#111" stroke-width="1.3" stroke-dasharray="6 4"/>`);
  return svgWrap(W, H, parts.join('\n'));
};


// ───────────────────────── Flowcharts 7-9: reschedule, cancel, add service ─────────────────────────
const laneChart = (title, steps, rules) => {
  const W = 1240, cx = 330;
  const lane = layLane(cx, 90, steps);
  const parts = [];
  parts.push(`<text x="${W / 2}" y="32" text-anchor="middle" font-size="20" font-weight="800" fill="#111">${esc(title)}</text>`);
  parts.push(...lane.links, ...lane.nodes.map(shape), ...lane.sides.map(shape));
  const px = 800, pw = 400, py = 130;
  const heights = rules.map(([, body]) => 44 + wrap(body, 52).length * 15);
  const total = heights.reduce((a, b) => a + b, 0) + 52;
  parts.push(`<rect x="${px}" y="${py - 40}" width="${pw}" height="${total}" rx="10" fill="none" stroke="#111" stroke-width="1.8"/>`);
  parts.push(`<rect x="${px}" y="${py - 40}" width="${pw}" height="34" rx="10" fill="#111"/>`);
  parts.push(`<text x="${px + pw / 2}" y="${py - 18}" text-anchor="middle" font-size="13" font-weight="800" fill="#fff">Rules</text>`);
  let y = py + 6;
  rules.forEach(([head, body], i) => {
    parts.push(`<line x1="${px}" y1="${y - 6}" x2="${px + pw}" y2="${y - 6}" stroke="#bbb"/>`);
    parts.push(`<text x="${px + 14}" y="${y + 14}" font-size="13" font-weight="800" fill="#111">${esc(head)}</text>`);
    parts.push(`<text font-size="12" fill="#111">${wrap(body, 52).map((t, k) => `<tspan x="${px + 14}" y="${y + 34 + k * 15}">${esc(t)}</tspan>`).join('')}</text>`);
    y += heights[i];
  });
  return svgWrap(W, Math.max(lane.endY + 110, y + 60), parts.join('\n'));
};

const rescheduleFlow = () => laneChart('Flowchart: Customer Reschedules a Booking', [
  { type: 'start', label: 'Customer opens their booking' },
  { type: 'decision', label: 'Is the booking Scheduled or Confirmed, with no vehicle started?', no: 'Reschedule is not offered', noLabel: 'No', yesLabel: 'Yes' },
  { type: 'step', label: 'Customer taps Reschedule and picks a new date and time' },
  { type: 'decision', label: 'Is the new time in the future and within shop hours?', no: 'Message shown; pick another time', noLabel: 'No', yesLabel: 'Yes' },
  { type: 'decision', label: 'Is the day open, not blocked, and the minimum notice met?', no: 'Message shown; pick another time', noLabel: 'No', yesLabel: 'Yes' },
  { type: 'decision', label: 'Is there room in the shop for the new time?', no: 'Time is full; pick another time', noLabel: 'No', yesLabel: 'Yes' },
  { type: 'step', label: 'The new date and time are saved, and the booking keeps its status' },
  { type: 'decision', label: 'Did the booking move to a different day?', yesLabel: 'No: the same day', no: 'The old shop allocation is cleared and re-assigned', noLabel: 'Yes' },
  { type: 'step', label: 'The change is recorded, and the customer and the shop are notified' },
  { type: 'end', label: 'Booking shows the new schedule' }
], [
  ['Same checks as booking', 'The database re-checks hours, closed days, blocked times, advance limit, minimum notice, and capacity. The screen check is only a convenience.'],
  ['Payments are kept', 'Rescheduling never changes the price or the payments already made.'],
  ['Who can do it', 'Only the customer who owns the booking, or an administrator. Once any vehicle has started, the booking can no longer be rescheduled.']
]);

const cancelFlow = () => laneChart('Flowchart: Customer Cancels a Booking', [
  { type: 'start', label: 'Customer opens their booking' },
  { type: 'decision', label: 'Is the booking Scheduled or Confirmed, with no vehicle started?', no: 'Cancel is not offered', noLabel: 'No', yesLabel: 'Yes' },
  { type: 'step', label: 'Customer taps Cancel booking (Danger Zone) and is asked for a reason' },
  { type: 'decision', label: 'Did the customer type a reason and confirm?', no: 'Nothing changes; booking stays', noLabel: 'No', yesLabel: 'Yes' },
  { type: 'step', label: 'The server checks the customer is signed in and owns the booking' },
  { type: 'step', label: 'The booking is cancelled, and its time slot and technicians are released' },
  { type: 'decision', label: 'Was any payment made or submitted?', yesLabel: 'Yes', no: 'No refund is needed', noLabel: 'No' },
  { type: 'step', label: 'The amount is queued as a refund for the administrator to review in the Refund Hub' },
  { type: 'step', label: 'The cancellation is recorded, and the customer is emailed with the refund status' },
  { type: 'end', label: 'Booking shows Cancelled' }
], [
  ['When it is allowed', 'Only before any vehicle has started work. After that, the shop must be contacted.'],
  ['Reason is required', 'The reason is kept with the booking and shown to the shop.'],
  ['Refunds', 'Nothing is paid back automatically. The administrator decides and records the refund, and the customer receives a refund receipt.'],
  ['Atomic', 'Cancelling and queuing the refund happen together, so one cannot happen without the other.']
]);

const addServiceFlow = () => laneChart('Flowchart: Adding a Service to an Existing Booking', [
  { type: 'start', label: 'Customer or administrator opens a booking and taps Add service' },
  { type: 'decision', label: 'Is the booking still active (not cancelled or completed)?', no: 'Add service is not offered', noLabel: 'No', yesLabel: 'Yes' },
  { type: 'step', label: 'Pick the vehicle and the service. The price and extra time are shown' },
  { type: 'step', label: 'If the price is above what is already paid, pay the difference by GCash or bank and upload the receipt (read automatically)' },
  { type: 'decision', label: 'If a receipt was uploaded, does it match the amount and shop account?', no: 'Admin can enter it by hand for checking', noLabel: 'No', yesLabel: 'Yes, or no receipt needed' },
  { type: 'step', label: 'The server looks up the real price and duration itself (the screen values are ignored)' },
  { type: 'decision', label: 'Does the extra time still fit the schedule?', no: 'Service not added; choose another time', noLabel: 'No', yesLabel: 'Yes' },
  { type: 'step', label: 'Service, new total, and payment are saved together in one step' },
  { type: 'step', label: 'The customer, the administrators, and the assigned staff are notified' },
  { type: 'end', label: 'Booking shows the new service and updated total' }
], [
  ['Price is not trusted', 'The price and duration come from the shop catalog on the server, never from the browser.'],
  ['Payment rules', 'The usual rules apply: a total of 1,000 or more cannot be paid in cash, and digital payments are verified by the administrator.'],
  ['All or nothing', 'If any step fails, nothing is added and no payment is recorded.'],
  ['Who can do it', 'The customer who owns the booking, or an administrator for walk-ins and phone requests.']
]);

(async () => {
  const out = { 'flowchart-account-creation': accountCreation(), 'flowchart-password-recovery': recovery(), 'flowchart-sign-in-lockout': signIn(), 'flowchart-access-control': accessControl(), 'flowchart-idle-signout': idleLogout(), 'flowchart-customer-booking': bookingFlow(), 'flowchart-reschedule': rescheduleFlow(), 'flowchart-cancel': cancelFlow(), 'flowchart-add-service': addServiceFlow() };
  for (const [name, svg] of Object.entries(out)) {
    fs.writeFileSync(path.join(__dirname, `${name}.svg`), svg);
    await sharp(Buffer.from(svg), { density: 150 }).png().toFile(path.join(__dirname, `${name}.png`));
    console.log('built', name);
  }
})();
