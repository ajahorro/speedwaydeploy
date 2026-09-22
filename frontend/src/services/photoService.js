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
export const uploadServicePhoto = async ({
  bookingId,
  bookingVehicleId,
  phase,
  file,
  caption = '',
  uploadedBy = null
}) => {
  if (!file) throw new Error('No file provided.');
  if (phase !== 'before' && phase !== 'after') throw new Error(`Invalid phase: ${phase}`);

  const ext = fileExtension(file);
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const objectName = `${unique}.${ext}`;
  const storagePath = buildObjectPath(bookingId, bookingVehicleId, phase, objectName);

  const { error: uploadError } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(storagePath, file, { cacheControl: '3600', upsert: false, contentType: file.type });
  if (uploadError) {
    logger.error('Service photo upload failed', uploadError);
    throw uploadError;
  }

  const { data, error: insertError } = await supabase
    .from('service_photos')
    .insert({
      booking_id: bookingId,
      booking_vehicle_id: bookingVehicleId,
      phase,
      storage_path: storagePath,
      caption: caption || null,
      uploaded_by: uploadedBy,
      source: 'upload'
    })
    .select()
    .single();

  if (insertError) {
    // Roll back the orphaned object so a failed DB write does not leave junk.
    await supabase.storage.from(PHOTO_BUCKET).remove([storagePath]).catch(() => { });
    logger.error('Service photo row insert failed', insertError);
    throw insertError;
  }

  return data;
};

/** Fetch all photos for a single vehicle unit, oldest first. */
export const fetchVehiclePhotos = async (bookingVehicleId) => {
  const { data, error } = await supabase
    .from('service_photos')
    .select('*')
    .eq('booking_vehicle_id', bookingVehicleId)
    .order('uploaded_at', { ascending: true });
  if (error) {
    logger.warn('Failed to fetch vehicle photos', error);
    return [];
  }
  return data || [];
};

/** Fetch all photos for a booking (all units), oldest first. */
export const fetchBookingPhotos = async (bookingId) => {
  const { data, error } = await supabase
    .from('service_photos')
    .select('*')
    .eq('booking_id', bookingId)
    .order('uploaded_at', { ascending: true });
  if (error) {
    logger.warn('Failed to fetch booking photos', error);
    return [];
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
 * Resolve a batch of service_photos rows to { ...row, url }.
 * Signs sequentially-safe in parallel; failures degrade to url=null.
 */
export const resolvePhotoUrls = async (photos = []) => {
  return Promise.all(
    photos.map(async (photo) => ({
      ...photo,
      url: await resolvePhotoUrl(photo.storage_path)
    }))
  );
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
