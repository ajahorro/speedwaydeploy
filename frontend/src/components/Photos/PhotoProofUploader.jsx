import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2, Trash2, X, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import toast from '@/lib/toast';
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

  // Photos are first collected in a tray (take or choose as many as needed, up to the limit), then submitted together.
  // Submitted evidence is locked, so nothing is saved until the technician presses Submit.
  const [staged, setStaged] = useState([]); // { id, file, url }
  const cameraRef = useRef(null);

  useEffect(() => () => { staged.forEach((item) => URL.revokeObjectURL(item.url)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFiles = (fileList) => {
    if (interactionDisabled || uploading) return;
    const files = Array.from(fileList || []);
    if (inputRef.current) inputRef.current.value = '';
    if (cameraRef.current) cameraRef.current.value = '';
    if (!files.length) return;
    const room = MAX_PHOTOS_PER_PHASE - photos.length - staged.length;
    if (files.length > room) {
      toast.error(room > 0 ? `You can add ${room} more photo${room === 1 ? '' : 's'} (maximum ${MAX_PHOTOS_PER_PHASE}).` : `The maximum is ${MAX_PHOTOS_PER_PHASE} photos.`);
    }
    const accepted = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      const problem = validate(file);
      if (problem) { toast.error(problem); continue; }
      accepted.push({ id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`, file, url: URL.createObjectURL(file) });
    }
    if (accepted.length) setStaged((prev) => [...prev, ...accepted]);
  };

  const unstage = (id) => setStaged((prev) => {
    const target = prev.find((item) => item.id === id);
    if (target) URL.revokeObjectURL(target.url);
    return prev.filter((item) => item.id !== id);
  });

  const submitStaged = () => {
    if (!staged.length) return;
    const files = staged.map((item) => item.file);
    confirmThen({
      title: phase === 'before' ? 'Submit the intake photos?' : 'Submit the completion photos?',
      message: `${files.length} photo${files.length > 1 ? 's' : ''} will be saved as the ${phase === 'before' ? 'before' : 'after'} evidence for this vehicle. Once submitted they are locked and cannot be added to or removed.`,
      confirmText: 'Submit photos'
    }, async () => {
      await sendFiles(files);
      setStaged((prev) => { prev.forEach((item) => URL.revokeObjectURL(item.url)); return []; });
    });
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
      ) : (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
        >
          <input ref={cameraRef} type="file" accept={ACCEPTED} capture="environment" disabled={interactionDisabled || uploading}
            onChange={(e) => handleFiles(e.target.files)} style={{ display: 'none' }} id={`photo-camera-${bookingVehicleId}-${phase}`} />
          <input ref={inputRef} type="file" accept={ACCEPTED} multiple disabled={interactionDisabled || uploading}
            onChange={(e) => handleFiles(e.target.files)} style={{ display: 'none' }} id={`photo-input-${bookingVehicleId}-${phase}`} />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {[['Take a photo', `photo-camera-${bookingVehicleId}-${phase}`, Camera], [staged.length ? 'Add more from gallery' : 'Choose photos', `photo-input-${bookingVehicleId}-${phase}`, ImagePlus]].map(([text, htmlFor, Icon]) => {
              const off = interactionDisabled || uploading || staged.length >= MAX_PHOTOS_PER_PHASE;
              return (
                <label key={htmlFor} htmlFor={htmlFor} aria-disabled={off}
                  style={{ flex: '1 1 140px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', minHeight: '44px', padding: '0.6rem 1rem', borderRadius: 'var(--admin-radius)', fontWeight: 900, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', cursor: off ? 'not-allowed' : 'pointer', background: off ? 'var(--admin-border)' : 'var(--admin-bg)', color: off ? 'var(--admin-text-secondary)' : 'var(--admin-text-primary)', border: '1px solid var(--admin-brand)', opacity: off ? 0.6 : 1, pointerEvents: off ? 'none' : 'auto' }}>
                  <Icon size={16} /> {text}
                </label>
              );
            })}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: 700 }}>
            Add as many as you need (up to {MAX_PHOTOS_PER_PHASE}), then submit them together · JPEG / PNG / WebP / HEIC, 10 MB each
          </div>

          {staged.length > 0 && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: '0.5rem' }}>
                {staged.map((item) => (
                  <figure key={item.id} style={{ ...tileStyle, margin: 0 }}>
                    <img src={item.url} alt="Selected photo" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    <button type="button" onClick={() => unstage(item.id)} aria-label="Remove this photo from the selection" disabled={uploading}
                      style={{ position: 'absolute', top: 4, right: 4, width: 26, height: 26, display: 'grid', placeItems: 'center', border: 'none', borderRadius: 'var(--admin-radius-sm)', cursor: 'pointer', background: 'rgba(0,0,0,0.65)', color: '#fff' }}>
                      <X size={14} />
                    </button>
                  </figure>
                ))}
              </div>
              <button type="button" onClick={submitStaged} disabled={uploading}
                style={{ minHeight: '46px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.7rem 1rem', background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: 'none', borderRadius: 'var(--admin-radius)', fontWeight: 950, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', cursor: uploading ? 'wait' : 'pointer' }}>
                {uploading ? <Loader2 size={16} className="spin" /> : <Camera size={16} />} {uploading ? 'Uploading…' : `Submit ${staged.length} photo${staged.length === 1 ? '' : 's'} (${staged.length} of ${MAX_PHOTOS_PER_PHASE})`}
              </button>
            </>
          )}
        </div>
      )}

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
