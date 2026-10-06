/**
 * Load a list a page at a time. Rows are fetched in chunks, newest first, and passed through `visible`
 * (the page's own filtering, e.g. hiding duplicates) until there are enough rows for the page plus one
 * more, which tells us whether a "See more" button is needed. The latest `pageSize` rows always show.
 *   fetchChunk(from, to) -> Promise<{ data, error }>   (inclusive range, like supabase .range)
 *   visible(rows)        -> rows to show (default: all)
 */
export const fetchVisiblePage = async ({ fetchChunk, visible = (rows) => rows, pageSize = 10, chunkSize = 40 }) => {
  let raw = [];
  let from = 0;
  let exhausted = false;
  let shown = [];
  while (!exhausted && shown.length <= pageSize) {
    const { data, error } = await fetchChunk(from, from + chunkSize - 1);
    if (error) throw error;
    const rows = data || [];
    raw = raw.concat(rows);
    from += chunkSize;
    exhausted = rows.length < chunkSize;
    shown = visible(raw);
  }
  return { rows: shown.slice(0, pageSize), hasMore: shown.length > pageSize };
};
