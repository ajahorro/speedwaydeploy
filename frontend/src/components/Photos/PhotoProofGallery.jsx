import React, { useEffect, useState } from 'react';
import { X, Image as ImageIcon, Loader2, Camera } from 'lucide-react';
import { fetchBookingPhotos, resolvePhotoUrls } from '../../services/photoService';

/**
 * PhotoProofGallery — Batch 5
 *
 * Slide-in drawer showing all evidence for a booking, grouped into Intake
 * (before) and Completion (after) sections. Storage paths are resolved to
 * short-lived signed URLs on open.
 *
 * Tokens only (var(...)); dark/light adaptive; 375px safe (full-width on mobile).
 */
const PhotoProofGallery = ({ bookingId, open, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [photos, setPhotos] = useState([]);
  const [lightbox, setLightbox] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!open || !bookingId) return;
      setLoading(true);
      try {
        const rows = await fetchBookingPhotos(bookingId);
        const resolved = await resolvePhotoUrls(rows);
        if (!cancelled) setPhotos(resolved);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [open, bookingId]);

  if (!open) return null;

  const before = photos.filter((p) => p.phase === 'before');
  const after = photos.filter((p) => p.phase === 'after');

  const Section = ({ title, items, tone }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.5rem',
        fontSize: '0.68rem', fontWeight: 950, textTransform: 'uppercase',
        letterSpacing: '0.08em', color: 'var(--admin-text-secondary)'
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: tone, display: 'inline-block' }} />
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-secondary)' }}>None on file.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: '0.5rem' }}>
          {items.map((p) => (
            <figure
              key={p.id}
              style={{
                margin: 0, position: 'relative', aspectRatio: '1 / 1',
                borderRadius: 'var(--admin-radius)', overflow: 'hidden',
                border: '1px solid var(--admin-border)', background: 'var(--admin-bg)'
              }}
            >
              {p.url ? (
                <img
                  src={p.url}
                  alt={p.caption || `${p.phase} photo`}
                  loading="lazy"
                  onClick={() => setLightbox(p)}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in', display: 'block' }}
                />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: 'var(--admin-text-secondary)' }}>
                  <ImageIcon size={16} />
                </div>
              )}
            </figure>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo evidence"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'var(--modal-overlay)', display: 'flex', justifyContent: 'flex-end'
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 100vw)', height: '100%',
          background: 'var(--admin-card)', color: 'var(--admin-text-primary)',
          borderLeft: '1px solid var(--admin-border)',
          display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--admin-card-shadow)'
        }}
      >
        <header style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '1rem', borderBottom: '1px solid var(--admin-border)'
        }}>
          <Camera size={16} color="var(--admin-brand)" />
          <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Photo Evidence
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: 'auto', width: 30, height: 30, display: 'grid', placeItems: 'center',
              border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)',
              background: 'transparent', color: 'var(--admin-text-primary)', cursor: 'pointer'
            }}
          >
            <X size={15} />
          </button>
        </header>

        <div style={{ padding: '1rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.72rem' }}>
              <Loader2 size={14} className="spin" /> Loading evidence…
            </div>
          ) : (
            <>
              <Section title="Intake (Before)" items={before} tone="var(--status-warning)" />
              <Section title="Completion (After)" items={after} tone="var(--status-success)" />
            </>
          )}
        </div>
      </aside>

      {lightbox && (
        <div
          onClick={(e) => { e.stopPropagation(); setLightbox(null); }}
          style={{ position: 'absolute', inset: 0, background: 'var(--modal-overlay)', display: 'grid', placeItems: 'center' }}
        >
          <img
            src={lightbox.url}
            alt={lightbox.caption || 'Service photo'}
            style={{
              maxWidth: 'min(92vw, 900px)', maxHeight: '86vh',
              borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)',
              objectFit: 'contain', background: 'var(--admin-card)'
            }}
          />
        </div>
      )}
    </div>
  );
};

export default PhotoProofGallery;
