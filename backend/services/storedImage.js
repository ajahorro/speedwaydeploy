const sharp = require('sharp');

/**
 * Shrink a picture for storage: fit inside 1600 px, WebP at quality 78 (~100-200 KB instead of 0.5-2 MB).
 * Reading it (OCR, duplicate checks) is done on the original before this. If the picture cannot be
 * converted (an unusual format), the original is stored unchanged.
 */
const shrinkForStorage = async (buffer, mimetype) => {
  try {
    const out = await sharp(buffer, { failOn: 'none', limitInputPixels: 50_000_000 })
      .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 }).toBuffer();
    return out.length < buffer.length ? { buffer: out, mimetype: 'image/webp', extension: 'webp' } : null;
  } catch {
    return null;
  }
};

module.exports = { shrinkForStorage };
