import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2, Trash2, X, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { useImagePreview } from '../../context/ImagePreviewContext';
import {
  uploadServicePhotos,
  fetchVehiclePhotos,
  resolvePhotoUrls,
  deleteServicePhoto
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
const MAX_PHOTOS_PER_PHASE = 10;

const PhotoProofUploader = ({
  bookingId,
  bookingVehicleId,
  phase = 'after',
  label,
  helperText,
  onCountChange,
  compact = false,
  disabled = false
}) => {
  const { confirmThen } = useConfirmAction();
  const { user } = useAuth();
  const inputRef = useRef(null);
  const [photos, setPhotos] = useState([]); // resolved rows: { ...row, url }
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const { openGallery } = useImagePreview();
  const onCountChangeRef = useRef(onCountChange);

  const heading = label || (phase === 'before' ? 'Intake Photos (Before)' : 'Completion Photos (After)');
  const evidenceLocked = photos.length > 0;
  const interactionDisabled = disabled || evidenceLocked || loading;
  const viewablePhotos = photos.filter((photo) => photo.url);
  const openPreview = (photoId) => openGallery(
    viewablePhotos.map((photo) => ({ src: photo.url, alt: photo.caption || `${phase} service photo`, caption: photo.caption || undefined })),
    Math.max(0, viewablePhotos.findIndex((photo) => photo.id === photoId))
  );

  const load = useCallback(async () => {
    if (!bookingVehicleId) return;
    setLoading(true);
    try {
      const rows = await fetchVehiclePhotos(bookingVehicleId);
      const scoped = rows.filter((r) => r.phase === phase);
      let resolved = scoped.map((row) => ({ ...row, url: null }));
      try {
        resolved = await resolvePhotoUrls(scoped);
      } catch {
        // Keep the records (and therefore the count) even without picture links.
      }
      setPhotos(resolved);
    } catch {
      toast.error('Could not load photos.');
    } finally {
      setLoading(false);
    }
  }, [bookingVehicleId, phase]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => { onCountChangeRef.current = onCountChange; }, [onCountChange]);

  useEffect(() => {
    if (typeof onCountChangeRef.current === 'function') onCountChangeRef.current(photos.length);
  }, [photos.length]);

  const validate = (file) => {
    if (!file.type.startsWith('image/')) return `"${file.name}" is not an image.`;
    if (file.size > MAX_BYTES) return `"${file.name}" exceeds the 10 MB limit.`;
    return null;
  };

  const handleFiles = async (fileList) => {
    if (interactionDisabled || uploading) return;
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (photos.length + files.length > MAX_PHOTOS_PER_PHASE) {
      toast.error(`Upload no more than ${MAX_PHOTOS_PER_PHASE} photos for this phase.`);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    for (const f of files) {
      const problem = validate(f);
      if (problem) {
        toast.error(problem);
        if (inputRef.current) inputRef.current.value = '';
        return;
      }
    }

    // Submitted evidence is locked (it cannot be added to or removed afterwards),
    // so the technician confirms before it is sent.
    // The picked files are already in hand; clear the input so the same photo can be picked again if this is cancelled.
    if (inputRef.current) inputRef.current.value = '';
    confirmThen({
      title: phase === 'before' ? 'Submit the intake photos?' : 'Submit the completion photos?',
      message: `${files.length} photo${files.length > 1 ? 's' : ''} will be saved as the ${phase === 'before' ? 'before' : 'after'} evidence for this vehicle. Once submitted they are locked and cannot be changed.`,
      confirmText: 'Upload photos'
    }, () => sendFiles(files));
  };

  const sendFiles = async (files) => {
    setUploading(true);
    const toastId = toast.loading(`Uploading ${files.length} photo${files.length > 1 ? 's' : ''}...`);
    try {
      await uploadServicePhotos({
        bookingId,
        bookingVehicleId,
        phase,
        files,
        uploadedBy: user?.id || null
      });
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
    if (interactionDisabled || uploading) return;
    handleFiles(e.dataTransfer.files);
  };

  const handleRemove = async (photo) => {
    if (evidenceLocked) return;
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
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: 700 }}>
          {photos.length} photo{photos.length === 1 ? '' : 's'}
        </span>
      </header>

      {helperText && (
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
          {helperText}
        </p>
      )}

      {/* Uploader dropzone / button */}
      {evidenceLocked ? (
        <p role="status" style={{ margin: 0, fontSize: '0.7rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
          Evidence saved. Photos in this submission are locked and can no longer be added or removed.
        </p>
      ) : <div
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
          disabled={interactionDisabled || uploading}
          onChange={(e) => handleFiles(e.target.files)}
          style={{ display: 'none' }}
          id={`photo-input-${bookingVehicleId}-${phase}`}
        />
        <label
          htmlFor={`photo-input-${bookingVehicleId}-${phase}`}
          aria-disabled={interactionDisabled || uploading}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            cursor: interactionDisabled || uploading ? 'not-allowed' : 'pointer',
            background: interactionDisabled || uploading ? 'var(--admin-border)' : 'var(--admin-brand)',
            color: interactionDisabled || uploading ? 'var(--admin-text-secondary)' : 'var(--admin-text-on-brand)',
            border: 'none',
            borderRadius: 'var(--admin-radius)',
            padding: '0.55rem 1rem',
            fontWeight: 900,
            fontSize: '0.72rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            opacity: interactionDisabled || uploading ? 0.6 : 1,
            pointerEvents: interactionDisabled || uploading ? 'none' : 'auto'
          }}
        >
          {uploading ? <Loader2 size={14} className="spin" /> : <ImagePlus size={14} />}
          {uploading ? 'Uploading…' : 'Add Photos'}
        </label>
        <div style={{ marginTop: '0.4rem', fontSize: '0.72rem', color: 'var(--admin-text-secondary)' }}>
          JPEG / PNG / WebP / HEIC · up to 10 MB each · max {MAX_PHOTOS_PER_PHASE}
        </div>
      </div>}

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
            : 'No intake photo yet — at least 1 is required before this unit can be started.'}
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
                  decoding="async"
                  onClick={() => openPreview(p.id)}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in', display: 'block' }}
                />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', fontSize: '0.72rem', color: 'var(--admin-text-secondary)' }}>
                  Unavailable
                </div>
              )}
              {p.source === 'legacy_backfill' && (
                <span
                  title="Imported from legacy records"
                  style={{
                    position: 'absolute', top: 4, left: 4, fontSize: '0.72rem', fontWeight: 900,
                    background: 'rgba(0,0,0,0.65)', color: 'var(--admin-text-on-brand)', padding: '0.1rem 0.3rem',
                    borderRadius: 'var(--admin-radius-sm)', letterSpacing: '0.05em'
                  }}
                >
                  LEGACY
                </span>
              )}
              {!evidenceLocked && <button
                type="button"
                onClick={() => confirmThen({ title: 'Remove this photo?', message: 'The photo is deleted from the booking and cannot be recovered.', confirmText: 'Remove photo', type: 'danger' }, () => handleRemove(p))}
                aria-label="Remove photo"
                style={{
                  position: 'absolute', top: 4, right: 4, width: 22, height: 22,
                  display: 'grid', placeItems: 'center', border: 'none',
                  borderRadius: 'var(--admin-radius-sm)', cursor: 'pointer',
                  background: 'rgba(0,0,0,0.6)', color: 'var(--admin-text-on-brand)'
                }}
              >
                <Trash2 size={12} />
              </button>}
            </figure>
          ))}
        </div>
      )}

    </section>
  );
};

export default PhotoProofUploader;
