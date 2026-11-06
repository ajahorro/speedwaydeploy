import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';

/**
 * Step-by-step guide that spotlights one part of the page at a time.
 *
 *   <GuidedTour open={open} onClose={() => setOpen(false)} steps={[
 *     { target: '[data-tour="vehicle"]', title: 'Pick a vehicle', body: 'Shows only the services for that vehicle.' },
 *     ...
 *   ]} />
 *
 * The rest of the page is dimmed (not hidden), the current part stays bright with a red outline, and a card with an
 * arrow points at it. Next / Back / Done, or the arrow keys and Escape. It scrolls each part into view, follows
 * resizing and scrolling, places the card above or below (whichever fits) and works on phones. Colours come from the
 * admin theme, so it follows light and dark mode. Steps whose target is not on screen are skipped.
 */
const PAD = 6;          // space between the element and its highlight
const GAP = 14;         // space between the highlight and the card
const CARD_W = 320;

const findTarget = (step) => (typeof step?.target === 'string' ? document.querySelector(step.target) : step?.target?.current || null);

export default function GuidedTour({ open, steps = [], onClose, startAt = 0 }) {
  // skip steps whose element is not on screen (for example the side menu, which is hidden on phones)
  const usable = steps.filter((s) => {
    if (!s || !s.target) return false;
    if (typeof s.target !== 'string' || typeof document === 'undefined') return true;
    const el = document.querySelector(s.target);
    return Boolean(el && el.getClientRects().length);
  });
  const [index, setIndex] = useState(startAt);
  const [rect, setRect] = useState(null);
  const [vp, setVp] = useState({ w: typeof window !== 'undefined' ? window.innerWidth : 1024, h: typeof window !== 'undefined' ? window.innerHeight : 768 });
  const cardRef = useRef(null);
  const [cardH, setCardH] = useState(160);

  useEffect(() => { if (open) setIndex(startAt); }, [open, startAt]);

  const step = usable[index];

  const measure = useCallback(() => {
    const el = findTarget(step);
    setVp({ w: window.innerWidth, h: window.innerHeight });
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
  }, [step]);

  // bring the step's element into view, then measure it
  useLayoutEffect(() => {
    if (!open || !step) return undefined;
    const el = findTarget(step);
    if (!el) { setRect(null); return undefined; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    measure();
    const t1 = setTimeout(measure, 250);
    const t2 = setTimeout(measure, 600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [open, step, measure]);

  // follow scrolling (any scroll container) and resizing
  useEffect(() => {
    if (!open) return undefined;
    const update = () => measure();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, measure]);

  useLayoutEffect(() => { if (cardRef.current) setCardH(cardRef.current.offsetHeight); }, [open, index, rect, vp.w]);

  const last = index >= usable.length - 1;
  const next = useCallback(() => (last ? onClose?.() : setIndex((i) => i + 1)), [last, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, next, back, onClose]);

  useEffect(() => { if (open) cardRef.current?.focus({ preventScroll: true }); }, [open, index]);

  if (!open || !step) return null;

  // card placement: below the element if it fits, otherwise above; centred on it, kept on screen
  const cardW = Math.min(CARD_W, vp.w - 32);
  let placement = step.placement || 'auto';
  let top;
  let left;
  let arrowLeft = cardW / 2;
  if (rect) {
    const below = rect.top + rect.height + GAP;
    const above = rect.top - GAP - cardH;
    if (placement === 'auto') placement = below + cardH <= vp.h - 12 || above < 12 ? 'bottom' : 'top';
    top = placement === 'bottom' ? below : above;
    top = Math.max(12, Math.min(top, vp.h - cardH - 12));
    const centre = rect.left + rect.width / 2;
    left = Math.max(16, Math.min(centre - cardW / 2, vp.w - cardW - 16));
    arrowLeft = Math.max(18, Math.min(centre - left, cardW - 18));
  } else {
    top = Math.max(12, vp.h / 2 - cardH / 2);
    left = (vp.w - cardW) / 2;
  }

  return createPortal(
    <div className="gt-root" role="dialog" aria-modal="true" aria-labelledby="gt-title" aria-describedby="gt-body">
      <style>{TOUR_CSS}</style>
      {/* clicks on the dimmed page do nothing (the page stays visible but out of reach until the guide closes) */}
      <div className="gt-blocker" onClick={(e) => e.stopPropagation()} />
      {rect ? (
        <div className="gt-spot" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />
      ) : (
        <div className="gt-dim" />
      )}
      <div ref={cardRef} tabIndex={-1} className={`gt-card gt-${placement}`} style={{ top, left, width: cardW }}>
        {rect && <span className="gt-arrow" style={{ left: arrowLeft }} aria-hidden="true" />}
        <div className="gt-head">
          <span className="gt-count">{`Step ${index + 1} of ${usable.length}`}</span>
          <button type="button" className="gt-x" onClick={onClose} aria-label="Close guide"><X size={16} /></button>
        </div>
        <h3 id="gt-title" className="gt-title">{step.title}</h3>
        <p id="gt-body" className="gt-body">{step.body}</p>
        <div className="gt-dots" aria-hidden="true">
          {usable.map((s, i) => <span key={i} className={i === index ? 'is-on' : ''} />)}
        </div>
        <div className="gt-actions">
          {index > 0 ? (
            <button type="button" className="gt-btn gt-ghost" onClick={back}><ArrowLeft size={15} /> Back</button>
          ) : (
            <button type="button" className="gt-btn gt-ghost" onClick={onClose}>Skip</button>
          )}
          <button type="button" className="gt-btn gt-primary" onClick={next}>
            {last ? 'Done' : <>Next <ArrowRight size={15} /></>}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** The small round "i" that starts a guide. */
export function TourInfoButton({ onClick, label = 'How this works' }) {
  return (
    // inline radius: the site-wide square-button rule leaves round controls alone when they say so inline
    <button type="button" className="gt-info" onClick={onClick} aria-label={label} title={label} style={{ borderRadius: '50%' }}>
      <style>{INFO_CSS}</style>
      <span aria-hidden="true">i</span>
    </button>
  );
}

const INFO_CSS = `
.gt-info { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; min-height:0; padding:0; flex-shrink:0;
  border-radius:50%; border:1.5px solid var(--admin-brand, #C41F2B); background:transparent; color:var(--admin-brand, #C41F2B);
  font:800 11px/1 Georgia, 'Times New Roman', serif; cursor:pointer; transition:background .15s ease, color .15s ease; }
.gt-info:hover, .gt-info:focus-visible { background:var(--admin-brand, #C41F2B); color:#fff; outline:none; }
@media (pointer: coarse) { .gt-info { width:22px; height:22px; font-size:13px; } }
`;

const TOUR_CSS = `
.gt-root { position:fixed; inset:0; z-index:10050; }
.gt-blocker { position:absolute; inset:0; }
.gt-dim { position:absolute; inset:0; background:rgba(0,0,0,.55); }
.gt-spot { position:fixed; border-radius:6px; pointer-events:none; box-shadow:0 0 0 9999px rgba(0,0,0,.55), 0 0 0 2px var(--admin-brand, #C41F2B);
  transition:top .25s ease, left .25s ease, width .25s ease, height .25s ease; }
.gt-card { position:fixed; box-sizing:border-box; padding:14px 16px 14px; border-radius:4px; outline:none;
  background:var(--admin-card, #fff); color:var(--admin-text-primary, #111); border:1px solid var(--admin-border, rgba(0,0,0,.1));
  box-shadow:0 18px 40px rgba(0,0,0,.35); transition:top .25s ease, left .25s ease; animation:gtIn .2s ease; }
@keyframes gtIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
.gt-arrow { position:absolute; width:14px; height:14px; margin-left:-7px; background:inherit; border:inherit; transform:rotate(45deg); }
.gt-bottom .gt-arrow { top:-8px; border-right:0; border-bottom:0; }
.gt-top .gt-arrow { bottom:-8px; border-left:0; border-top:0; }
.gt-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }
.gt-count { font-size:11px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--admin-brand, #C41F2B); }
.gt-x { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; min-height:0; padding:0; border:0; border-radius:2px;
  background:transparent; color:var(--admin-text-secondary, #666); cursor:pointer; }
.gt-x:hover { color:var(--admin-text-primary, #111); }
.gt-title { margin:0 0 4px; font-size:15px; font-weight:800; line-height:1.3; }
.gt-body { margin:0; font-size:13.5px; line-height:1.5; color:var(--admin-text-secondary, #555); }
.gt-dots { display:flex; gap:5px; margin:12px 0 10px; }
.gt-dots span { width:6px; height:6px; border-radius:50%; background:var(--admin-border, rgba(0,0,0,.15)); }
.gt-dots span.is-on { background:var(--admin-brand, #C41F2B); width:16px; border-radius:3px; }
.gt-actions { display:flex; justify-content:space-between; gap:8px; }
.gt-btn { display:inline-flex; align-items:center; gap:6px; min-height:36px; padding:0 14px; border-radius:2px; font-size:13px; font-weight:700; cursor:pointer; }
.gt-ghost { background:transparent; color:var(--admin-text-primary, #111); border:1px solid var(--admin-border, rgba(0,0,0,.15)); }
.gt-primary { background:var(--admin-brand, #C41F2B); color:#fff; border:1px solid var(--admin-brand, #C41F2B); }
@media (prefers-reduced-motion: reduce) { .gt-spot, .gt-card { transition:none; animation:none; } }
`;

/** The "i" button and its guide together: <TourLauncher steps={TOURS.promos} label="How promos work" />. */
export function TourLauncher({ steps, label = 'How this works' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TourInfoButton onClick={() => setOpen(true)} label={label} />
      <GuidedTour open={open} steps={steps} onClose={() => setOpen(false)} />
    </>
  );
}
