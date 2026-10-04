// In-page layout/theme audit used for the 1.6 polish pass.
// Usage (browser console or the Browser pane, signed in, dev server running):
//   1. Copy frontend/public/__audit.js alongside this file is NOT needed: paste this file into the console.
//   2. await window.__auditPage("/admin/bookings", "light")  // or "dark"
// Reports horizontal overflow at the current viewport width, elements sticking out
// of the viewport, and text with a contrast ratio under 2.6. Resize the viewport
// first (375 phone, 768 tablet, 1280 desktop).
window.__auditPage = async (route, theme) => {
  document.documentElement.dataset.theme = theme;
  window.history.pushState({}, '', route);
  window.dispatchEvent(new PopStateEvent('popstate'));
  await new Promise((r) => setTimeout(r, 2600));
  const vw = window.innerWidth;
  const sel = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).slice(0, 2).join('.');
    return el.tagName.toLowerCase() + id + (cls ? '.' + cls : '');
  };
  const out = { route, theme, vw, scrollOverflow: document.documentElement.scrollWidth - vw, offenders: [], contrast: [] };
  const seen = new Set();
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return;
    // inside its own horizontal scroller is fine
    let p = el.parentElement, scrolled = false;
    while (p && p !== document.body) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden') { scrolled = true; break; }
      p = p.parentElement;
    }
    if (!scrolled && r.right > vw + 2 && out.offenders.length < 6) {
      const k = sel(el);
      if (!seen.has(k)) { seen.add(k); out.offenders.push(k + ' right=' + Math.round(r.right)); }
    }
  });
  const lum = (c) => {
    const m = c.match(/[\d.]+/g); if (!m) return null;
    const [r, g, b, a = 1] = m.map(Number);
    if (a < 0.1) return null;
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return { l: 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b), a };
  };
  const bgOf = (el) => {
    let e = el;
    while (e) {
      const c = getComputedStyle(e).backgroundColor;
      const L = lum(c);
      if (L && L.a > 0.5) return L.l;
      e = e.parentElement;
    }
    return theme === 'light' ? 1 : 0;
  };
  const seenC = new Set();
  document.querySelectorAll('body *').forEach((el) => {
    if (out.contrast.length >= 8) return;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasText) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.3) return;
    const fg = lum(cs.color); if (!fg) return;
    const bg = bgOf(el);
    const hi = Math.max(fg.l, bg), lo = Math.min(fg.l, bg);
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < 2.6) {
      const k = sel(el) + el.textContent.trim().slice(0, 12);
      if (!seenC.has(k)) { seenC.add(k); out.contrast.push(`${sel(el)} "${el.textContent.trim().slice(0, 24)}" ratio=${ratio.toFixed(1)}`); }
    }
  });
  return out;
};
'installed';
