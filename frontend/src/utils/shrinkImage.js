/**
 * Shrink a picture before it is stored: fit inside 1600 px, WebP at quality 0.78 (JPEG where the browser
 * cannot write WebP). Typically 100-250 KB instead of 0.5-2 MB, and still sharp on screen and when zoomed.
 * Anything that is not a decodable image, or would not get smaller, is returned unchanged.
 */
const MAX_EDGE = 1600;

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

export const shrinkImage = async (file) => {
  if (!(file instanceof Blob) || !/^image\//.test(file.type) || typeof createImageBitmap !== 'function') return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return file; }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob = await toBlob(canvas, 'image/webp', 0.78);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.8);
    if (!blob || blob.size >= file.size) return file;
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    const name = `${String(file.name || 'photo').replace(/\.[^.]+$/, '')}.${ext}`;
    return new File([blob], name, { type: blob.type, lastModified: Date.now() });
  } finally {
    bitmap.close?.();
  }
};
