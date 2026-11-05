/**
 * Short, readable date ranges for tables (Manila time):
 *   Oct 7–8, 2026 · Oct 7 – Nov 2, 2026 · Dec 30, 2026 – Jan 2, 2027 · From Oct 7, 2026 · Until Oct 8, 2026 · No end date
 */
const TZ = 'Asia/Manila';
const part = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const get = (opt) => d.toLocaleDateString('en-US', { timeZone: TZ, ...opt });
  return { month: get({ month: 'short' }), day: get({ day: 'numeric' }), year: get({ year: 'numeric' }) };
};

export function formatDateRange(fromIso, untilIso) {
  const a = fromIso ? part(fromIso) : null;
  const b = untilIso ? part(untilIso) : null;
  if (!a && !b) return 'No end date';
  if (a && !b) return `From ${a.month} ${a.day}, ${a.year}`;
  if (!a && b) return `Until ${b.month} ${b.day}, ${b.year}`;
  if (a.year === b.year && a.month === b.month) {
    return a.day === b.day ? `${a.month} ${a.day}, ${a.year}` : `${a.month} ${a.day}–${b.day}, ${a.year}`;
  }
  if (a.year === b.year) return `${a.month} ${a.day} – ${b.month} ${b.day}, ${a.year}`;
  return `${a.month} ${a.day}, ${a.year} – ${b.month} ${b.day}, ${b.year}`;
}
