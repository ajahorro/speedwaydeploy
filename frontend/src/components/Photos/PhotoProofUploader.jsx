import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2, Trash2, X, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import {
  uploadServicePhoto,
  fetchVehiclePhotos,
  resolvePhotoUrls,
  deleteServicePhoto,
  isAbsoluteUrl
} from '../../services/photoService';

/**
 * PhotoProofUploader — Batch 5
 *
 * Capture/upload evidence for a single booking vehicle unit, split by phase:
 *   phase="before"  intake photos (soft warning elsewhere)
 *   phase="after"   completion/QA photos (hard gate elsewhere)
 *
 * Styling: native admin design tokens only (var(...)). Adapts to dark/light via
 * those tokens; laid out for 375px mobile first.
 */
const ACCEPTED = 'image/jpeg,image/png,image/webp,image/heic';
const MAX_BYTES = 10 * 1024 * 1024; // mirrors the bucket's 10 MB limit

const PhotoProofUploader = ({
  bookingId,
  bookingVehicleId,
  phase = 'after',
  label,
  helperText,
  onCountChange,
  compact = false
}) => {
  const { user } = useAuth();
  const inputRef = useRef(null);
  const [photos, setPhotos] = useState([]); // resolved rows: { ...row, url }
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  const heading = label || (phase === 'before' ? 'Intake Photos (Before)' : 'Completion Photos (After)');

  const load = useCallback(async () => {
    if (!bookingVehicleId) return;
    setLoading(true);
    try {
      const rows = await fetchVehiclePhotos(bookingVehicleId);
      const scoped = rows.filter((r) => r.phase === phase);
      const resolved = await resolvePhotoUrls(scoped);
      setPhotos(resolved);
    } catch {
      toast.error('Could not load photos.');
    } finally {
      setLoading(false);
    }
  }, [bookingVehicleId, phase]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (typeof onCountChange === 'function') onCountChange(photos.length);
  }, [photos.length, onCountChange]);

  const validate = (file) => {
    if (!file.type.startsWith('image/')) return `"${file.name}" is not an image.`;
    if (file.size > MAX_BYTES) return `"${file.name}" exceeds the 10 MB limit.`;
    return null;
  };

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    for (const f of files) {
      const problem = validate(f);
      if (problem) { toast.error(problem); return; }
    }

    setUploading(true);
    const toastId = toast.loading(`Uploading ${files.length} photo${files.length > 1 ? 's' : ''}...`);
    try {
      for (const f of files) {
        await uploadServicePhoto({
          bookingId,
          bookingVehicleId,
          phase,
          file: f,
          uploadedBy: user?.id || null
        });
      }
      toast.success('Evidence uploaded.', { id: toastId });
      await load();
    } catch (err) {
      toast.error(err.message || 'Upload failed.', { id: toastId });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  const handleRemove = async (photo) => {
    const toastId = toast.loading('Removing photo...');
    try {
      await deleteServicePhoto(photo);
      toast.success('Photo removed.', { id: toastId });
      await load();
    } catch (err) {
      toast.error(err.message || 'Remove failed.', { id: toastId });
    }
  };

  const tileStyle = {
    position: 'relative',
    aspectRatio: '1 / 1',
    borderRadius: 'var(--admin-radius)',
    overflow: 'hidden',
    border: '1px solid var(--admin-border)',
    background: 'var(--admin-bg)'
  };

  return (
    <section
      aria-label={heading}
      style={{
        background: 'var(--admin-card)',
        border: '1px solid var(--admin-border)',
        borderRadius: 'var(--admin-radius)',
        padding: compact ? '0.75rem' : '1.25rem',
        color: 'var(--admin-text-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem'
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Camera size={15} color="var(--admin-brand)" />
        <h4 style={{ margin: 0, fontSize: '0.72rem', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '1px' }}>
          {heading}
        </h4>
        <span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--admin-text-secondary)', fontWeight: 700 }}>
          {photos.length} photo{photos.length === 1 ? '' : 's'}
        </span>
      </header>

      {helperText && (
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
          {helperText}
        </p>
      )}

      {/* Uploader dropzone / button */}
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        style={{
          border: '1px dashed var(--admin-input-border, var(--admin-border))',
          borderRadius: 'var(--admin-radius)',
          padding: '0.9rem',
          textAlign: 'center',
          background: 'var(--admin-bg)'
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          capture="environment"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          style={{ display: 'none' }}
          id={`photo-input-${bookingVehicleId}-${phase}`}
        />
        <label
          htmlFor={`photo-input-${bookingVehicleId}-${phase}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            cursor: uploading ? 'not-allowed' : 'pointer',
            background: uploading ? 'var(--admin-border)' : 'var(--admin-brand)',
            color: 'var(--admin-text-on-brand)',
            border: 'none',
            borderRadius: 'var(--admin-radius)',
            padding: '0.55rem 1rem',
            fontWeight: 900,
            fontSize: '0.72rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            opacity: uploading ? 0.6 : 1,
            pointerEvents: uploading ? 'none' : 'auto'
          }}
        >
          {uploading ? <Loader2 size={14} className="spin" /> : <ImagePlus size={14} />}
          {uploading ? 'Uploading…' : 'Add Photos'}
        </label>
        <div style={{ marginTop: '0.4rem', fontSize: '0.62rem', color: 'var(--admin-text-secondary)' }}>
          JPEG / PNG / WebP / HEIC · up to 10 MB each
        </div>
      </div>

      {/* Gallery */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.72rem' }}>
          <Loader2 size={14} className="spin" /> Loading photos…
        </div>
      ) : photos.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.7rem',
            color: 'var(--admin-text-secondary)',
            border: `1px solid ${phase === 'after' ? 'var(--status-warning)' : 'var(--admin-border)'}`,
            background: phase === 'after' ? 'rgba(var(--admin-brand-rgb), 0.06)' : 'transparent',
            borderRadius: 'var(--admin-radius)',
            padding: '0.6rem 0.75rem'
          }}
        >
          <AlertTriangle size={14} color="var(--status-warning)" />
          {phase === 'after'
            ? 'No completion photo yet — at least 1 is required before this unit can be completed.'
            : 'No intake photo yet. Recommended before starting work.'}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
            gap: '0.5rem'
          }}
        >
          {photos.map((p) => (
            <figure key={p.id} style={{ ...tileStyle, margin: 0 }}>
              {p.url ? (
                <img
                  src={p.url}
                  alt={p.caption || `${phase} service photo`}
                  loading="lazy"
                  onClick={() => setLightbox(p)}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in', display: 'block' }}
                />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', fontSize: '0.6rem', color: 'var(--admin-text-secondary)' }}>
                  Unavailable
                </div>
              )}
              {p.source === 'legacy_backfill' && (
                <span
                  title="Imported from legacy records"
                  style={{
                    position: 'absolute', top: 4, left: 4, fontSize: '0.5rem', fontWeight: 900,
                    background: 'rgba(0,0,0,0.65)', color: 'var(--admin-text-on-brand)', padding: '0.1rem 0.3rem',
                    borderRadius: 'var(--admin-radius-sm)', letterSpacing: '0.05em'
                  }}
                >
                  LEGACY
                </span>
              )}
              <button
                type="button"
                onClick={() => handleRemove(p)}
                aria-label="Remove photo"
                style={{
                  position: 'absolute', top: 4, right: 4, width: 22, height: 22,
                  display: 'grid', placeItems: 'center', border: 'none',
                  borderRadius: 'var(--admin-radius-sm)', cursor: 'pointer',
                  background: 'rgba(0,0,0,0.6)', color: 'var(--admin-text-on-brand)'
                }}
              >
                <Trash2 size={12} />
              </button>
            </figure>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'var(--modal-overlay)', display: 'grid', placeItems: 'center', padding: '1rem'
          }}
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="Close"
            style={{
              position: 'absolute', top: 16, right: 16, width: 34, height: 34,
              display: 'grid', placeItems: 'center', border: '1px solid var(--admin-border)',
              borderRadius: 'var(--admin-radius)', background: 'var(--admin-card)',
              color: 'var(--admin-text-primary)', cursor: 'pointer'
            }}
          >
            <X size={16} />
          </button>
          <img
            src={lightbox.url}
            alt={lightbox.caption || 'Service photo'}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 'min(92vw, 900px)', maxHeight: '86vh',
              borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)',
              objectFit: 'contain', background: 'var(--admin-card)'
            }}
          />
          {lightbox.caption && (
            <div style={{ color: 'var(--admin-text-on-brand)', fontSize: '0.75rem', marginTop: '0.5rem', textAlign: 'center' }}>
              {lightbox.caption}
              {isAbsoluteUrl(lightbox.storage_path) ? ' (legacy record)' : ''}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default PhotoProofUploader;
