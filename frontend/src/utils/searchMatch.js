/**
 * One way to match a search box against a record.
 *
 *   const shown = rows.filter((row) => matchesSearchText(query, row.name, row.id, row.vehicles?.map(v => v.plate)));
 *
 * - Case-insensitive and accent-insensitive.
 * - A leading "#" is ignored, so "#A1B2C3D4" finds the booking shown as #A1B2C3D4.
 * - Several words must ALL appear somewhere in the record, in any order and in
 *   any field ("john civic" finds John's Honda Civic booking).
 * - Empty values (null, undefined, nested arrays of them) are skipped, so a
 *   missing field can never match the text "undefined" or "null".
 */

export const normalizeSearch = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/#/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const searchTokens = (query) => normalizeSearch(query).split(' ').filter(Boolean);

const flatten = (parts) =>
  parts.flat(Infinity).filter((part) => part !== null && part !== undefined && part !== false && part !== '');

export const buildHaystack = (...parts) => normalizeSearch(flatten(parts).join(' '));

// An id typed or pasted with or without its dashes ("9a0000...", "9a000000-0000-...") finds the same record, and so does
// any piece of it (the start, the end, a middle part): the search looks inside the id, never only at a shortened version.
const withoutDashes = (text) => text.replace(/-/g, '');

export const matchesSearchText = (query, ...parts) => {
  const tokens = searchTokens(query);
  if (!tokens.length) return true;
  const haystack = buildHaystack(...parts);
  const compact = withoutDashes(haystack);
  return tokens.every((token) => haystack.includes(token) || compact.includes(withoutDashes(token)));
};

/** Make free text safe to place inside a PostgREST .or() / ilike filter value. */
export const escapeForPostgrestFilter = (query) =>
  String(query ?? '').replace(/[%,()*\\]/g, ' ').replace(/\s+/g, ' ').trim();
