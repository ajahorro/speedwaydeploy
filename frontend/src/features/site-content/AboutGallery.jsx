import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * The landing page's About photos, in one of four layouts chosen in Business Hub › About & Map.
 * The same component draws the live landing page and the admin's "See preview", so the preview is exact.
 *
 *   mosaic   – one large photo with smaller ones beside it; captions sit on the photos.
 *   carousel – one photo at a time with arrows and dots; the caption is a band under the photo.
 *   grid     – an even grid; each caption sits under its photo.
 *   split    – photo and caption side by side, alternating sides; the caption is the main text.
 *
 * Captions are plain text (React escapes them). Every layout stacks to one column on phones.
 */
export const ABOUT_LAYOUTS = [
  { id: 'mosaic', label: 'Mosaic', hint: 'One large photo, smaller ones beside it. Captions on the photos.' },
  { id: 'carousel', label: 'Slideshow', hint: 'One photo at a time with arrows. Caption under the photo.' },
  { id: 'grid', label: 'Grid', hint: 'Even rows of photos. Caption under each one.' },
  { id: 'split', label: 'Story', hint: 'Photo and caption side by side, alternating. Captions read like a story.' },
];

function Carousel({ photos }) {
  const [index, setIndex] = useState(0);
  const count = photos.length;
  useEffect(() => { if (index > count - 1) setIndex(0); }, [count, index]);
  if (!count) return null;
  const go = (step) => setIndex((i) => (i + step + count) % count);
  const photo = photos[Math.min(index, count - 1)];
  return (
    <div className="ag-carousel" role="group" aria-roledescription="carousel" aria-label="About photos">
      <div className="ag-carousel-frame">
        <img key={photo.id} src={photo.url} alt={photo.caption || `Photo ${index + 1} of ${count}`} loading="lazy" />
        {count > 1 && (
          <>
            <button type="button" className="ag-arrow ag-arrow-left" onClick={() => go(-1)} aria-label="Previous photo"><ChevronLeft size={20} /></button>
            <button type="button" className="ag-arrow ag-arrow-right" onClick={() => go(1)} aria-label="Next photo"><ChevronRight size={20} /></button>
          </>
        )}
      </div>
      <div className="ag-carousel-band">
        <p>{photo.caption || ' '}</p>
        {count > 1 && (
          <div className="ag-dots">
            {photos.map((p, i) => (
              <button key={p.id} type="button" className={i === index ? 'is-active' : ''} onClick={() => setIndex(i)} aria-label={`Show photo ${i + 1}`} aria-current={i === index} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AboutGallery({ photos = [], layout = 'mosaic' }) {
  const list = (Array.isArray(photos) ? photos : []).filter((p) => p && p.url);
  if (!list.length) return null;

  let body;
  if (layout === 'carousel') {
    body = <Carousel photos={list} />;
  } else if (layout === 'grid') {
    body = (
      <ul className="ag-grid">
        {list.map((p, i) => (
          <li key={p.id}>
            <img src={p.url} alt={p.caption || `About photo ${i + 1}`} loading="lazy" />
            {p.caption && <p>{p.caption}</p>}
          </li>
        ))}
      </ul>
    );
  } else if (layout === 'split') {
    body = (
      <ul className="ag-split">
        {list.map((p, i) => (
          <li key={p.id} className={i % 2 ? 'is-flipped' : ''}>
            <img src={p.url} alt={p.caption || `About photo ${i + 1}`} loading="lazy" />
            <div className="ag-split-text"><span className="ag-split-num">{String(i + 1).padStart(2, '0')}</span><p>{p.caption || ''}</p></div>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <ul className={`ag-mosaic ag-count-${Math.min(list.length, 5)}`}>
        {list.map((p, i) => (
          <li key={p.id} className={i === 0 ? 'is-lead' : ''}>
            <img src={p.url} alt={p.caption || `About photo ${i + 1}`} loading="lazy" />
            {p.caption && <p>{p.caption}</p>}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="ag-root">
      <style>{GALLERY_CSS}</style>
      {body}
    </div>
  );
}

const GALLERY_CSS = `
.ag-root { --ag-line: rgba(255,255,255,.1); --ag-muted: rgba(255,255,255,.72); --ag-red: #C41F2B; width: 100%; }
.ag-root ul { list-style: none; margin: 0; padding: 0; }
.ag-root img { display: block; width: 100%; height: 100%; object-fit: cover; background: #1b1d21; }

.ag-mosaic { display: grid; gap: .75rem; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: clamp(120px, 14vw, 190px); }
.ag-mosaic li { position: relative; overflow: hidden; border-radius: 4px; border: 1px solid var(--ag-line); }
.ag-mosaic li.is-lead { grid-column: span 2; grid-row: span 2; }
.ag-mosaic.ag-count-1 li.is-lead { grid-column: 1 / -1; }
.ag-mosaic.ag-count-2 li { grid-column: span 2; grid-row: span 2; }
.ag-mosaic li p { position: absolute; inset: auto 0 0 0; margin: 0; padding: 1.75rem .85rem .7rem; font-size: .82rem; font-weight: 700; color: #fff;
  background: linear-gradient(to top, rgba(0,0,0,.82), rgba(0,0,0,0)); line-height: 1.35; }
.ag-mosaic li img { transition: transform .5s ease; }
.ag-mosaic li:hover img { transform: scale(1.04); }

.ag-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); }
.ag-grid li { display: flex; flex-direction: column; border: 1px solid var(--ag-line); border-radius: 4px; overflow: hidden; background: rgba(255,255,255,.03); }
.ag-grid li img { aspect-ratio: 4 / 3; height: auto; }
.ag-grid li p { margin: 0; padding: .75rem .9rem; font-size: .85rem; color: var(--ag-muted); line-height: 1.45; }

.ag-split { display: grid; gap: 1.5rem; }
.ag-split li { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: clamp(1rem, 3vw, 2rem); align-items: center; }
.ag-split li.is-flipped img { order: 2; }
.ag-split li img { aspect-ratio: 16 / 10; height: auto; border-radius: 4px; border: 1px solid var(--ag-line); }
.ag-split-num { display: block; font-size: .75rem; font-weight: 900; letter-spacing: 2px; color: var(--ag-red); margin-bottom: .4rem; }
.ag-split-text p { margin: 0; font-size: clamp(1rem, 1.6vw, 1.25rem); font-weight: 700; line-height: 1.45; color: #fff; }

.ag-carousel { border: 1px solid var(--ag-line); border-radius: 4px; overflow: hidden; background: rgba(255,255,255,.03); }
.ag-carousel-frame { position: relative; aspect-ratio: 16 / 9; }
.ag-arrow { position: absolute; top: 50%; transform: translateY(-50%); width: 42px; height: 42px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 2px; border: 1px solid rgba(255,255,255,.25); background: rgba(10,11,13,.65); color: #fff; cursor: pointer; }
.ag-arrow:hover { background: var(--ag-red); border-color: var(--ag-red); }
.ag-arrow-left { left: .75rem; } .ag-arrow-right { right: .75rem; }
.ag-carousel-band { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .85rem 1rem; flex-wrap: wrap; }
.ag-carousel-band p { margin: 0; font-size: .9rem; font-weight: 600; color: var(--ag-muted); flex: 1 1 220px; }
.ag-dots { display: flex; gap: .4rem; }
.ag-dots button { width: 9px; height: 9px; min-height: 0; padding: 0; border-radius: 50%; border: 0; background: rgba(255,255,255,.3); cursor: pointer; }
.ag-dots button.is-active { background: var(--ag-red); }

@media (max-width: 720px) {
  .ag-mosaic { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: 140px; }
  .ag-mosaic li.is-lead, .ag-mosaic.ag-count-2 li { grid-column: 1 / -1; grid-row: span 2; }
  .ag-split li { grid-template-columns: 1fr; }
  .ag-split li.is-flipped img { order: 0; }
}
`;
