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
  side: { w: 150, h: 70, chars: 19 }
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
      const sx = laneX + 125 + 46 + SIZE.side.w / 2;
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

(async () => {
  const out = { 'flowchart-account-creation': accountCreation(), 'flowchart-password-recovery': recovery() };
  for (const [name, svg] of Object.entries(out)) {
    fs.writeFileSync(path.join(__dirname, `${name}.svg`), svg);
    await sharp(Buffer.from(svg), { density: 150 }).png().toFile(path.join(__dirname, `${name}.png`));
    console.log('built', name);
  }
})();
