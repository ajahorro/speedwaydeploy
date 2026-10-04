import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';

/**
 * The one image pop-up for the whole app (payment receipts, proof of payment,
 * chat pictures, OCR scans, service photos).
 *
 *   const { openImage, openGallery } = useImagePreview();
 *   openImage(url, { alt: 'Receipt' });
 *   openGallery([{ src, alt }, ...], startIndex);
 *
 * Nothing that shows an image should call window.open or use target="_blank":
 * the picture opens in this overlay, on the same page. Close with the X, a click
 * on the backdrop, or Escape. Arrow keys / buttons move through a gallery, and
 * the zoom buttons (or double-click) enlarge it.
 */

const ImagePreviewContext = createContext(null);

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

export const ImagePreviewProvider = ({ children }) => {
  const [state, setState] = useState(null); // { images: [{src, alt}], index }
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef(null);

  const close = useCallback(() => {
    setState(null);
    setZoom(1);
    setFailed(false);
  }, []);

  const openGallery = useCallback((images, index = 0) => {
    const list = (images || [])
      .map((item) => (typeof item === 'string' ? { src: item } : item))
      .filter((item) => item && item.src);
    if (!list.length) return;
    setZoom(1);
    setFailed(false);
    setState({ images: list, index: Math.min(Math.max(index, 0), list.length - 1) });
  }, []);

  const openImage = useCallback((src, options = {}) => {
    if (!src) return;
    openGallery([{ src, alt: options.alt, caption: options.caption }], 0);
  }, [openGallery]);

  const step = useCallback((delta) => {
    setState((current) => {
      if (!current || current.images.length < 2) return current;
      const next = (current.index + delta + current.images.length) % current.images.length;
      return { ...current, index: next };
    });
    setZoom(1);
    setFailed(false);
  }, []);

  const isOpen = Boolean(state);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, close, step]);

  const value = useMemo(() => ({ openImage, openGallery, closeImage: close }), [openImage, openGallery, close]);
  const current = state ? state.images[state.index] : null;
  const many = state ? state.images.length > 1 : false;

  const roundButton = {
    width: 42, height: 42, display: 'grid', placeItems: 'center', cursor: 'pointer',
    borderRadius: '50%', border: '1px solid var(--admin-border, #444)',
    background: 'var(--admin-card, #1a1a1a)', color: 'var(--admin-text-primary, #fff)'
  };

  return (
    <ImagePreviewContext.Provider value={value}>
      {children}
      {current && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={current.alt || 'Image preview'}
          onClick={close}
          style={{
            position: 'fixed', inset: 0, zIndex: 100000, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: '0.75rem', padding: '1rem',
            background: 'rgba(0,0,0,0.88)'
          }}
        >
          <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', display: 'flex', gap: '0.5rem' }}
            onClick={(event) => event.stopPropagation()}>
            <button type="button" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM}
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.5))} style={{ ...roundButton, opacity: zoom <= MIN_ZOOM ? 0.4 : 1 }}>
              <ZoomOut size={18} />
            </button>
            <button type="button" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM}
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.5))} style={{ ...roundButton, opacity: zoom >= MAX_ZOOM ? 0.4 : 1 }}>
              <ZoomIn size={18} />
            </button>
            <button type="button" aria-label="Close image" ref={closeRef} onClick={close} style={roundButton}>
              <X size={20} />
            </button>
          </div>

          {many && (
            <>
              <button type="button" aria-label="Previous image"
                onClick={(event) => { event.stopPropagation(); step(-1); }}
                style={{ ...roundButton, position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)' }}>
                <ChevronLeft size={22} />
              </button>
              <button type="button" aria-label="Next image"
                onClick={(event) => { event.stopPropagation(); step(1); }}
                style={{ ...roundButton, position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)' }}>
                <ChevronRight size={22} />
              </button>
            </>
          )}

          <div
            onClick={(event) => event.stopPropagation()}
            style={{ maxWidth: '100%', maxHeight: 'calc(100% - 3.5rem)', overflow: 'auto', display: 'flex' }}
          >
            {failed ? (
              <div style={{ color: '#fff', padding: '2rem', fontWeight: 700 }}>This image could not be loaded.</div>
            ) : (
              <img
                key={current.src}
                src={current.src}
                alt={current.alt || 'Preview'}
                decoding="async"
                onError={() => setFailed(true)}
                onDoubleClick={() => setZoom((z) => (z > 1 ? 1 : 2))}
                style={{
                  margin: 'auto', borderRadius: '8px', background: '#fff',
                  maxWidth: zoom === 1 ? '100%' : 'none', maxHeight: zoom === 1 ? 'calc(100vh - 5rem)' : 'none',
                  width: zoom === 1 ? 'auto' : `${zoom * 100}%`, objectFit: 'contain',
                  cursor: zoom > 1 ? 'zoom-out' : 'zoom-in'
                }}
              />
            )}
          </div>

          {(current.caption || many) && (
            <span onClick={(event) => event.stopPropagation()} style={{ color: '#fff', fontSize: '0.75rem', fontWeight: 800 }}>
              {many ? `${state.index + 1} / ${state.images.length}` : ''}{many && current.caption ? ' · ' : ''}{current.caption || ''}
            </span>
          )}
        </div>
      )}
    </ImagePreviewContext.Provider>
  );
};

export const useImagePreview = () => {
  const context = useContext(ImagePreviewContext);
  if (!context) {
    throw new Error('useImagePreview must be used within an ImagePreviewProvider');
  }
  return context;
};
