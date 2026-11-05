import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Shared pagination for admin lists: 10 rows a page everywhere (the existing-customer picker is the one exception).
 *
 *   const { rows, pager } = usePaged(items, { resetKey: [search, filter] });
 *   ...render rows... {pager}
 *
 * The page goes back to 1 when resetKey changes (a new search or filter) and never sits past the last page when the
 * list shrinks. The bar follows the admin theme tokens, so it works in light and dark mode and wraps on phones.
 */
export const PAGE_SIZE = 10;

export function ListPager({ page, pages, total, from, to, onPage, label = 'results' }) {
  if (total <= 0) return null;
  const btn = (disabled) => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, minHeight: 36, padding: 0,
    background: 'transparent', border: '1px solid var(--admin-border)', borderRadius: '2px',
    color: 'var(--admin-text-primary)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1
  });
  return (
    <nav
      aria-label="Pages"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem 1rem', flexWrap: 'wrap',
        padding: '0.65rem 0.25rem', fontSize: '0.8rem', color: 'var(--admin-text-secondary)'
      }}
    >
      <span>{from}–{to} of {total} {label}</span>
      {pages > 1 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          <button type="button" style={btn(page === 0)} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span style={{ minWidth: '5.5rem', textAlign: 'center', color: 'var(--admin-text-primary)' }}>Page {page + 1} of {pages}</span>
          <button type="button" style={btn(page >= pages - 1)} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </span>
      )}
    </nav>
  );
}

export function usePaged(items, { perPage = PAGE_SIZE, resetKey = null, label } = {}) {
  const list = Array.isArray(items) ? items : [];
  const [page, setPage] = useState(0);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const key = JSON.stringify(resetKey);

  useEffect(() => { setPage(0); }, [key, perPage]);
  useEffect(() => { if (page > pages - 1) setPage(pages - 1); }, [page, pages]);

  const safePage = Math.min(page, pages - 1);
  const start = safePage * perPage;
  const rows = useMemo(() => list.slice(start, start + perPage), [list, start, perPage]);
  const pager = (
    <ListPager page={safePage} pages={pages} total={total} from={start + 1} to={Math.min(total, start + perPage)} onPage={setPage} label={label} />
  );
  return { rows, page: safePage, setPage, pages, total, start, pager };
}
