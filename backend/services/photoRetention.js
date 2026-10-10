/**
 * Service photo retention, second phase (purge).
 *
 * The database archives photos after 12 months. A photo that has been archived and is past the purge window
 * (24 months by default, set in the Business Hub) and is not on legal hold is removed here: its stored file first,
 * then its record. Doing the file first means a failed removal leaves the record in place, and the next run tries
 * again; the other order would lose track of a file for good.
 *
 * Only files in the private service-proofs bucket are removed. An older record that points at a full web address
 * (legacy photos) has its record removed but its file is left alone, because it lives outside this bucket.
 */
const PRIVATE_BUCKET = 'service-proofs';

const purgeExpiredServicePhotos = async (supabase, { batchSize = 100, maxBatches = 20 } = {}) => {
  let records = 0;
  let files = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const { data: due, error } = await supabase.rpc('service_photos_due_for_purge', { p_limit: batchSize });
    if (error) throw error;
    if (!due || due.length === 0) break;

    const paths = due
      .map((row) => String(row.storage_path || ''))
      .filter((storagePath) => storagePath && !/^https?:\/\//i.test(storagePath));
    if (paths.length) {
      const { data: removed, error: removeError } = await supabase.storage.from(PRIVATE_BUCKET).remove(paths);
      if (removeError) throw removeError;
      files += (removed || []).length;
    }

    const { error: deleteError } = await supabase.from('service_photos').delete().in('id', due.map((row) => row.id));
    if (deleteError) throw deleteError;
    records += due.length;

    if (due.length < batchSize) break;
  }

  return { records, files };
};

module.exports = { purgeExpiredServicePhotos, PRIVATE_BUCKET };
