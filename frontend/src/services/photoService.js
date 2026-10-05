/**
 * photoService.js — Batch 5 photo proof persistence + retrieval.
 *
 * The private `service-proofs` bucket backs public.service_photos. Objects are
 * NEVER public; the UI requests short-lived signed URLs (15 min) at render time
 * and the DB stores only the bucket-relative `storage_path`.
 *
 * Legacy rows (source = 'legacy_backfill') hold an absolute public URL as their
 * `storage_path`. `resolvePhotoUrl` detects those and returns them untouched so
 * historic evidence still displays.
 */
import { supabase } from '../lib/supabase';
import { logger } from '../utils/logger';

export const PHOTO_BUCKET = 'service-proofs';
export const SIGNED_URL_TTL_SECONDS = 15 * 60; // 15 minutes

/** True when a stored value is an already-resolvable absolute URL (legacy). */
export const isAbsoluteUrl = (value) =>
  typeof value === 'string' && /^https?:\/\//i.test(value.trim());

/**
 * Build the canonical object path: <booking_id>/<booking_vehicle_id>/<phase>/<file>.
 * The first folder segment (booking_id) is what the storage RLS policies use to
 * authorize access, so this shape must not change.
 */
const buildObjectPath = (bookingId, bookingVehicleId, phase, fileName) =>
  `${bookingId}/${bookingVehicleId}/${phase}/${fileName}`;

const fileExtension = (file) => {
  const fromName = file?.name?.includes('.') ? file.name.split('.').pop() : '';
  if (fromName) return fromName.toLowerCase();
  // Fall back to the MIME subtype (image/jpeg -> jpeg).
  const sub = (file?.type || '').split('/')[1];
  return (sub || 'jpg').toLowerCase().replace('jpeg', 'jpg');
};

const MAX_IMAGE_EDGE = 1920;
const COMPRESS_ABOVE_BYTES = 1.5 * 1024 * 1024;

const canvasToBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error('The selected photo could not be optimized.'));
  }, type, quality);
});

/**
 * Downsize camera images before upload to reduce cellular transfer time.
 * Unsupported formats (for example HEIC on browsers without a decoder) are
 * preserved unchanged rather than blocking evidence capture.
 */
export const optimizeServicePhoto = async (file) => {
  if (!(file instanceof File) || file.size <= COMPRESS_ABOVE_BYTES
    || typeof createImageBitmap !== 'function') return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.type === 'image/jpeg' && file.size <= 4 * 1024 * 1024) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return file;

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    let blob;
    try {
      blob = await canvasToBlob(canvas, 'image/jpeg', 0.82);
    } catch (error) {
      logger.warn('Could not optimize service photo; uploading the original file', error);
      return file;
    }
    if (blob.size >= file.size) return file;

    const baseName = String(file.name || 'service-photo').replace(/\.[^.]+$/, '');
    return new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: file.lastModified || Date.now()
    });
  } finally {
    bitmap.close();
  }
};

/**
 * Upload a photo to the private bucket and record it in service_photos.
 *
 * @param {object}  opts
 * @param {string}  opts.bookingId
 * @param {string}  opts.bookingVehicleId
 * @param {'before'|'after'} opts.phase
 * @param {File}    opts.file
 * @param {string}  [opts.caption]
 * @param {string}  [opts.uploadedBy]  auth uid of the uploader
 * @returns {Promise<object>} the inserted service_photos row
 */
export const uploadServicePhotos = async ({
  bookingId,
  bookingVehicleId,
  phase,
  files,
  caption = '',
  uploadedBy = null
}) => {
  const photoFiles = Array.from(files || []);
  if (!photoFiles.length) throw new Error('At least one photo is required.');
  if (phase !== 'before' && phase !== 'after') throw new Error(`Invalid phase: ${phase}`);

  const storagePaths = [];
  try {
    for (let index = 0; index < photoFiles.length; index += 2) {
      const batch = await Promise.all(photoFiles.slice(index, index + 2).map(optimizeServicePhoto));
      const results = await Promise.allSettled(batch.map(async (file) => {
        const ext = fileExtension(file);
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const storagePath = buildObjectPath(bookingId, bookingVehicleId, phase, `${unique}.${ext}`);
        const { error: uploadError } = await supabase.storage
          .from(PHOTO_BUCKET)
          .upload(storagePath, file, { cacheControl: '3600', upsert: false, contentType: file.type });
        if (uploadError) throw uploadError;
        storagePaths.push(storagePath);
        return storagePath;
      }));
      const failedUpload = results.find((result) => result.status === 'rejected');
      if (failedUpload) throw failedUpload.reason;
    }

    const { data, error: insertError } = await supabase
      .from('service_photos')
      .insert(storagePaths.map((storagePath) => ({
      booking_id: bookingId,
      booking_vehicle_id: bookingVehicleId,
      phase,
      storage_path: storagePath,
      caption: caption || null,
      uploaded_by: uploadedBy,
      source: 'upload'
      })))
      .select('id, booking_id, booking_vehicle_id, phase, storage_path, caption, uploaded_by, source, uploaded_at');

    if (insertError) throw insertError;
    return data || [];
  } catch (error) {
    if (storagePaths.length) {
      const { error: cleanupError } = await supabase.storage.from(PHOTO_BUCKET).remove(storagePaths);
      if (cleanupError) logger.error('Failed to clean up service photos after upload failure', cleanupError);
    }
    logger.error('Service photo submission failed', error);
    throw error;
  }
};

export const uploadServicePhoto = async ({ file, ...options }) => {
  const [photo] = await uploadServicePhotos({ ...options, files: [file] });
  return photo;
};

/** Fetch all photos for a single vehicle unit, oldest first. */
export const fetchVehiclePhotos = async (bookingVehicleId) => {
  const { data, error } = await supabase
    .from('service_photos')
    .select('id, booking_id, booking_vehicle_id, phase, storage_path, caption, uploaded_by, source, uploaded_at')
    .eq('booking_vehicle_id', bookingVehicleId)
    .is('archived_at', null)
    .order('uploaded_at', { ascending: true });
  if (error) {
    logger.warn('Failed to fetch vehicle photos', error);
    throw error;
  }
  return data || [];
};

/** Fetch all photos for a booking (all units), oldest first. */
export const fetchBookingPhotos = async (bookingId) => {
  const { data, error } = await supabase
    .from('service_photos')
    .select('id, booking_id, booking_vehicle_id, phase, storage_path, caption, uploaded_by, source, uploaded_at')
    .eq('booking_id', bookingId)
    .is('archived_at', null)
    .order('uploaded_at', { ascending: true });
  if (error) {
    logger.warn('Failed to fetch booking photos', error);
    throw error;
  }
  return data || [];
};

/**
 * Count 'after' photos for a unit — used to gate the Complete action on the
 * client before the server-side hard block would reject it.
 */
export const countAfterPhotos = async (bookingVehicleId) => {
  const { count, error } = await supabase
    .from('service_photos')
    .select('id', { count: 'exact', head: true })
    .eq('booking_vehicle_id', bookingVehicleId)
    .eq('phase', 'after');
  if (error) {
    logger.warn('Failed to count after photos', error);
    return 0;
  }
  return count || 0;
};

/**
 * Resolve one storage_path to a displayable URL.
 * - Absolute URLs (legacy backfill) are returned verbatim.
 * - Bucket paths are signed for a short TTL.
 * Returns null when no URL can be produced (so callers can show a placeholder).
 */
export const resolvePhotoUrl = async (storagePath) => {
  if (!storagePath) return null;
  if (isAbsoluteUrl(storagePath)) return storagePath;

  const { data, error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) {
    logger.warn('Failed to sign photo URL', error);
    return null;
  }
  return data?.signedUrl || null;
};

/**
 * Resolve a batch of service_photos rows using one storage signing request.
 * Legacy absolute URLs are kept untouched; signing failures are logged and
 * represented by url=null so the gallery can render its unavailable state.
 */
export const resolvePhotoUrls = async (photos = []) => {
  const paths = Array.from(new Set(
    photos.map((photo) => photo.storage_path)
      .filter((path) => path && !isAbsoluteUrl(path))
  ));
  const signedByPath = new Map();

  if (paths.length) {
    // A failure to create the picture links must never hide the photos themselves:
    // the saved records are what count (a technician who uploaded an intake photo
    // has uploaded it, whether or not its thumbnail can be drawn right now). The
    // photo then shows as "Unavailable" until the link can be made.
    try {
      const { data, error } = await supabase.storage
        .from(PHOTO_BUCKET)
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
      if (error) {
        logger.warn('Failed to sign service photo URLs', error);
      } else {
        for (const result of data || []) {
          if (result.error) logger.warn(`Failed to sign service photo ${result.path}`, result.error);
          signedByPath.set(result.path, result.signedUrl || null);
        }
      }
    } catch (signError) {
      logger.warn('Failed to sign service photo URLs', signError);
    }
  }

  return photos.map((photo) => ({
    ...photo,
    url: isAbsoluteUrl(photo.storage_path)
      ? photo.storage_path
      : signedByPath.get(photo.storage_path) || null
  }));
};

/** Delete a photo row and its storage object. Admin-only at the RLS layer. */
export const deleteServicePhoto = async (photo) => {
  if (!photo?.id) return;
  if (photo.storage_path && !isAbsoluteUrl(photo.storage_path)) {
    await supabase.storage.from(PHOTO_BUCKET).remove([photo.storage_path]).catch(() => { });
  }
  const { error } = await supabase.from('service_photos').delete().eq('id', photo.id);
  if (error) {
    logger.error('Failed to delete service photo', error);
    throw error;
  }
};
