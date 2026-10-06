// Sequence diagram helper. parts = ['Customer', ...]; msgs = [{f, t, label, ret?}] with f/t as part indexes (f === t = a step inside one part).
const { wrap, txt, svgWrap, title, esc } = require('./lib.cjs');

const seq = (heading, parts, msgs, o = {}) => {
  const colW = o.colW || 230;
  const left = 60;
  const W = left * 2 + colW * parts.length - 60;
  const xs = parts.map((_, i) => left + colW / 2 + i * colW);
  const p = [title(W, heading)];
  const topY = 70;
  let y = topY + 70;
  const rows = [];
  msgs.forEach((m, i) => {
    const self = m.f === m.t;
    const dx = Math.abs(xs[m.t] - xs[m.f]);
    const max = self ? m.max || o.selfMax || 46 : Math.max(16, Math.floor((dx - 20) / 6.4));
    const ls = wrap(`${i + 1}. ${m.label}`, max);
    const h = self ? Math.max(48, ls.length * 14 + 26) : 30 + ls.length * 14;
    rows.push({ m, ls, y: y + (self ? 8 : h - 8), top: y, h, self });
    y += h + 6;
  });
  const bottom = y + 20;
  parts.forEach((name, i) => {
    p.push(`<line x1="${xs[i]}" y1="${topY + 40}" x2="${xs[i]}" y2="${bottom}" stroke="#111" stroke-width="1.2" stroke-dasharray="6 5"/>`);
    p.push(`<rect x="${xs[i] - 85}" y="${topY}" width="170" height="40" rx="6" fill="#111"/>`);
    p.push(txt(xs[i], topY + 20, name, 22, 13, 800, 'middle', '#fff'));
    p.push(`<rect x="${xs[i] - 85}" y="${bottom}" width="170" height="40" rx="6" fill="#111"/>`);
    p.push(txt(xs[i], bottom + 20, name, 22, 13, 800, 'middle', '#fff'));
  });
  rows.forEach(({ m, ls, y: ry, top, h, self }) => {
    if (self) {
      const x = xs[m.f];
      p.push(`<rect x="${x - 6}" y="${top + 4}" width="12" height="${h - 14}" fill="#fff" stroke="#111" stroke-width="1.4"/>`);
      p.push(`<path d="M${x + 6},${top + 12} L${x + 34},${top + 12} L${x + 34},${top + 34} L${x + 6},${top + 34}" fill="none" stroke="#111" stroke-width="1.6" marker-end="url(#a)"/>`);
      p.push(`<text font-size="11.5" font-weight="600" fill="#111" stroke="#fff" stroke-width="4" paint-order="stroke">${ls.map((l, k) => `<tspan x="${x + 44}" y="${top + 16 + k * 14}">${esc(l)}</tspan>`).join('')}</text>`);
    } else {
      const x1 = xs[m.f]; const x2 = xs[m.t];
      const dir = x2 > x1 ? 1 : -1;
      p.push(`<path d="M${x1 + dir * 2},${ry} L${x2 - dir * 2},${ry}" fill="none" stroke="#111" stroke-width="1.6"${m.ret ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#a)"/>`);
      const mid = (x1 + x2) / 2;
      p.push(`<text text-anchor="middle" font-size="11.5" font-weight="600" fill="#111" stroke="#fff" stroke-width="4" paint-order="stroke">${ls.map((l, k) => `<tspan x="${mid}" y="${ry - 8 - (ls.length - 1 - k) * 14}">${esc(l)}</tspan>`).join('')}</text>`);
    }
  });
  const H = bottom + 90;
  if (o.key) p.push(`<text x="40" y="${H - 18}" font-size="11.5" fill="#111">${esc(o.key)}</text>`);
  return svgWrap(W, H, p.join('\n'));
};
module.exports = { seq };
