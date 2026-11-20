// sharp/libvips cannot decode real HEIC/HEIF photos (only AVIF) because the HEVC
// decoder is patent-encumbered and left out of the prebuilt binaries — so an
// iPhone photo uploaded straight from Photos (still HEIC unless "Most Compatible"
// is set) throws instead of being read. heic-convert bundles its own decoder and
// converts it to a JPEG buffer before any sharp call ever sees it.
const heicConvert = require('heic-convert');

const toJpegIfHeic = async (buffer, mimetype) => {
  if (mimetype !== 'image/heic' && mimetype !== 'image/heif') return { buffer, mimetype };
  const jpeg = await heicConvert({ buffer, format: 'JPEG', quality: 0.92 });
  return { buffer: jpeg, mimetype: 'image/jpeg' };
};

module.exports = { toJpegIfHeic };
