import React, { useEffect, useState } from 'react';
import { X, Image as ImageIcon, Loader2, Camera, ChevronLeft, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { fetchBookingPhotos, fetchVehiclePhotos, resolvePhotoUrls } from '../../services/photoService';

/**
 * PhotoProofGallery — Batch 5
 *
 * Slide-in drawer showing all evidence for a booking, grouped into Intake
 * (before) and Completion (after) sections. Storage paths are resolved to
 * short-lived signed URLs on open.
 *
 * Tokens only (var(...)); dark/light adaptive; 375px safe (full-width on mobile).
 */
const PhotoProofGallery = ({ bookingId, bookingVehicleId = null, open, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [photos, setPhotos] = useState([]);
  const [lightboxIndex, setLightboxIndex] = useState(null);

  useEffect(() => {
    if (lightboxIndex === null) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setLightboxIndex(null);
      const viewableCount = photos.filter((photo) => photo.url).length;
      if (viewableCount && event.key === 'ArrowLeft') setLightboxIndex((index) => (index - 1 + viewableCount) % viewableCount);
      if (viewableCount && event.key === 'ArrowRight') setLightboxIndex((index) => (index + 1) % viewableCount);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxIndex, photos]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!open || (!bookingId && !bookingVehicleId)) return;
      setLoading(true);
      try {
        const rows = bookingVehicleId
          ? await fetchVehiclePhotos(bookingVehicleId)
          : await fetchBookingPhotos(bookingId);
        const resolved = await resolvePhotoUrls(rows);
        if (!cancelled) setPhotos(resolved);
      } catch (error) {
        if (!cancelled) {
          setPhotos([]);
          toast.error(error.message || 'Could not load photo evidence.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [open, bookingId, bookingVehicleId]);

  if (!open) return null;

  const before = photos.filter((p) => p.phase === 'before');
  const after = photos.filter((p) => p.phase === 'after');
  const viewablePhotos = photos.filter((photo) => photo.url);
  const lightboxPhoto = lightboxIndex === null ? null : viewablePhotos[lightboxIndex];
  const showPreviousPhoto = () => setLightboxIndex((index) => (index - 1 + viewablePhotos.length) % viewablePhotos.length);
  const showNextPhoto = () => setLightboxIndex((index) => (index + 1) % viewablePhotos.length);

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
                  decoding="async"
                  onClick={() => setLightboxIndex(viewablePhotos.findIndex((photo) => photo.id === p.id))}
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

      {lightboxPhoto && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Photo ${lightboxIndex + 1} of ${viewablePhotos.length}`}
          onClick={(event) => event.stopPropagation()}
          onTouchStart={(event) => { event.currentTarget.dataset.touchStartX = String(event.touches[0]?.clientX || 0); }}
          onTouchEnd={(event) => {
            const startX = Number(event.currentTarget.dataset.touchStartX);
            const deltaX = event.changedTouches[0]?.clientX - startX;
            if (Math.abs(deltaX) > 50) {
              if (deltaX > 0) showPreviousPhoto();
              else showNextPhoto();
            }
          }}
          style={{ position: 'absolute', inset: 0, zIndex: 2, background: 'var(--modal-overlay)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', padding: '3.5rem 3rem 1rem' }}
        >
          <button
            type="button"
            aria-label="Close photo"
            onClick={() => setLightboxIndex(null)}
            style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', width: 42, height: 42, display: 'grid', placeItems: 'center', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', background: 'var(--admin-card)', color: 'var(--admin-text-primary)', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
          <button
            type="button"
            aria-label="Previous photo"
            onClick={(event) => { event.stopPropagation(); showPreviousPhoto(); }}
            style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', width: 42, height: 42, display: 'grid', placeItems: 'center', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', background: 'var(--admin-card)', color: 'var(--admin-text-primary)', cursor: 'pointer' }}
          >
            <ChevronLeft size={22} />
          </button>
          <img
            src={lightboxPhoto.url}
            alt={lightboxPhoto.caption || `${lightboxPhoto.phase} service photo`}
            decoding="async"
            onClick={(event) => event.stopPropagation()}
            style={{
              maxWidth: '100%', maxHeight: 'calc(100% - 2rem)',
              borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)',
              objectFit: 'contain', background: 'var(--admin-card)'
            }}
          />
          <span style={{ color: 'var(--admin-text-primary)', fontSize: '0.72rem', fontWeight: 800 }}>
            {lightboxIndex + 1} / {viewablePhotos.length}{lightboxPhoto.caption ? ` · ${lightboxPhoto.caption}` : ''}
          </span>
          <button
            type="button"
            aria-label="Next photo"
            onClick={(event) => { event.stopPropagation(); showNextPhoto(); }}
            style={{ position: 'absolute', right: '0.6rem', top: '50%', transform: 'translateY(-50%)', width: 42, height: 42, display: 'grid', placeItems: 'center', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', background: 'var(--admin-card)', color: 'var(--admin-text-primary)', cursor: 'pointer' }}
          >
            <ChevronRight size={22} />
          </button>
        </div>
      )}
    </div>
  );
};

export default PhotoProofGallery;
