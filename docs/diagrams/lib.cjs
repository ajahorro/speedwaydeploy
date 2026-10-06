// Shared drawing helpers for the system diagrams (black and white, prints well).
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
/** Wrapped text block centred (or anchored) on x,y. */
const txt = (x, y, label, max, size = 12, weight = 400, anchor = 'middle', fill = '#111', italic = false) => {
  const ls = wrap(label, max);
  const y0 = y - ((ls.length - 1) * (size + 3)) / 2 + size / 3;
  return `<text text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}"${italic ? ' font-style="italic"' : ''}>${ls.map((l, i) => `<tspan x="${x}" y="${y0 + i * (size + 3)}">${esc(l)}</tspan>`).join('')}</text>`;
};
const svgWrap = (W, H, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#111"/></marker></defs>
<rect width="${W}" height="${H}" fill="#fff"/>
${body}
</svg>`;
const title = (W, t) => `<text x="${W / 2}" y="32" text-anchor="middle" font-size="20" font-weight="800" fill="#111">${esc(t)}</text>`;

/** Box with a bold title and an optional smaller subtitle. cx,cy = centre. */
const box = (cx, cy, w, h, head, sub = '', o = {}) => {
  const rx = o.rx ?? 8;
  const fill = o.fill || '#fff';
  const stroke = o.stroke || '#111';
  const sw = o.sw || 1.8;
  let s = `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${o.dashed ? ' stroke-dasharray="7 4"' : ''}/>`;
  const tc = o.textFill || '#111';
  if (sub) {
    s += txt(cx, cy - h / 2 + 20, head, o.max || Math.floor(w / 7.4), 13, 800, 'middle', tc);
    s += txt(cx, cy + 8 + (wrap(head, o.max || Math.floor(w / 7.4)).length - 1) * 6, sub, o.subMax || Math.floor(w / 6.2), 11, 400, 'middle', tc);
  } else {
    s += txt(cx, cy, head, o.max || Math.floor(w / 7.4), o.size || 13, 800, 'middle', tc);
  }
  return s;
};
/** Arrow along points with an optional label. */
const arr = (pts, label = '', lab = null, o = {}) => {
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  let s = `<path d="${d}" fill="none" stroke="#111" stroke-width="${o.sw || 1.6}"${o.dashed ? ' stroke-dasharray="7 4"' : ''}${o.noHead ? '' : ' marker-end="url(#a)"'}${o.start ? ' marker-start="url(#a)"' : ''}/>`;
  if (label && lab) s += txt(lab[0], lab[1], label, o.max || 22, o.size || 11.5, 600, lab[2] || 'middle');
  return s;
};
const save = async (dir, out) => {
  for (const [name, svg] of Object.entries(out)) {
    fs.writeFileSync(path.join(dir, `${name}.svg`), svg);
    await sharp(Buffer.from(svg), { density: 150 }).png().toFile(path.join(dir, `${name}.png`));
    console.log('built', name);
  }
};
module.exports = { esc, wrap, txt, svgWrap, title, box, arr, save };
