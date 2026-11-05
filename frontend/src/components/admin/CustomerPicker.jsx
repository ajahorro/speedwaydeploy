import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';

/**
 * Existing-customer picker for admin bookings (walk-in wizard).
 *
 * Two side-by-side ways to pick the same customer (stacked on narrow screens):
 *   - Browse: a dropdown listing customers 5 per page, with page controls inside the dropdown.
 *   - Search: type part of a name (or email) and pick from the matches, also 5 per page.
 * Every row shows the name AND the email, so two customers with the same name can be told apart.
 * Styling: .cp-* in index.css, built on the admin theme tokens, so it follows light/dark mode.
 */
export const CUSTOMERS_PER_PAGE = 5;

export const customerName = (profile) => {
  const full = String(profile?.full_name || '').trim();
  if (full) return full;
  const parts = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim();
  return parts || String(profile?.email || 'Unnamed customer');
};

const byName = (a, b) => customerName(a).localeCompare(customerName(b), undefined, { sensitivity: 'base' })
  || String(a?.email || '').localeCompare(String(b?.email || ''), undefined, { sensitivity: 'base' });

/** One page of rows plus page controls; shared by the browse dropdown and the search results. */
function CustomerList({ id, items, page, setPage, selectedId, activeIndex, setActiveIndex, onPick, emptyText, label }) {
  const pages = Math.max(1, Math.ceil(items.length / CUSTOMERS_PER_PAGE));
  const start = page * CUSTOMERS_PER_PAGE;
  const rows = items.slice(start, start + CUSTOMERS_PER_PAGE);
  return (
    <div className="cp-panel">
      {rows.length === 0 ? (
        <p className="cp-empty">{emptyText}</p>
      ) : (
        <ul className="cp-list" id={id} role="listbox" aria-label={label}>
          {rows.map((customer, i) => {
            const selected = customer.id === selectedId;
            return (
              <li
                key={customer.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={selected}
                className={`cp-option${selected ? ' is-selected' : ''}${i === activeIndex ? ' is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                // mousedown, not click: picks before the input/trigger loses focus and closes the panel.
                onMouseDown={(e) => { e.preventDefault(); onPick(customer); }}
              >
                <span className="cp-name">{customerName(customer)}</span>
                <span className="cp-email">{customer.email || 'No email on file'}</span>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > CUSTOMERS_PER_PAGE && (
        <div className="cp-pager">
          <button type="button" className="cp-page-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => { setPage(page - 1); setActiveIndex(0); }} disabled={page === 0} aria-label="Previous page">
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className="cp-page-label">Page {page + 1} of {pages} · {items.length} customers</span>
          <button type="button" className="cp-page-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => { setPage(page + 1); setActiveIndex(0); }} disabled={page >= pages - 1} aria-label="Next page">
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Arrow keys move through the visible page (and across pages), Enter picks, Escape closes. */
const makeListKeys = ({ items, page, setPage, activeIndex, setActiveIndex, onPick, onClose }) => (event) => {
  const start = page * CUSTOMERS_PER_PAGE;
  const onPage = items.slice(start, start + CUSTOMERS_PER_PAGE).length;
  const pages = Math.max(1, Math.ceil(items.length / CUSTOMERS_PER_PAGE));
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (activeIndex < onPage - 1) setActiveIndex(activeIndex + 1);
    else if (page < pages - 1) { setPage(page + 1); setActiveIndex(0); }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (activeIndex > 0) setActiveIndex(activeIndex - 1);
    else if (page > 0) { setPage(page - 1); setActiveIndex(CUSTOMERS_PER_PAGE - 1); }
  } else if (event.key === 'Enter') {
    const customer = items[start + activeIndex];
    if (customer) { event.preventDefault(); onPick(customer); }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    onClose();
  }
};

export default function CustomerPicker({ customers = [], value = '', onChange, disabled = false }) {
  const uid = useId().replace(/:/g, '');
  const sorted = useMemo(() => [...customers].sort(byName), [customers]);
  const selected = sorted.find((c) => c.id === value) || null;

  // Browse dropdown
  const browseRef = useRef(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePage, setBrowsePage] = useState(0);
  const [browseActive, setBrowseActive] = useState(0);

  // Search
  const searchRef = useRef(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchPage, setSearchPage] = useState(0);
  const [searchActive, setSearchActive] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return sorted.filter((c) => customerName(c).toLowerCase().includes(q) || String(c.email || '').toLowerCase().includes(q));
  }, [query, sorted]);

  // Close either panel on a click outside it.
  useEffect(() => {
    const onDown = (e) => {
      if (browseRef.current && !browseRef.current.contains(e.target)) setBrowseOpen(false);
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, []);

  const pick = (customer) => {
    onChange?.(customer.id);
    setBrowseOpen(false);
    setSearchOpen(false);
    setQuery('');
  };

  const openBrowse = () => {
    if (disabled) return;
    // Open on the page that holds the current selection.
    const index = selected ? sorted.findIndex((c) => c.id === selected.id) : 0;
    setBrowsePage(Math.max(0, Math.floor(index / CUSTOMERS_PER_PAGE)));
    setBrowseActive(Math.max(0, index % CUSTOMERS_PER_PAGE));
    setBrowseOpen(true);
    setSearchOpen(false);
  };

  const browseKeys = makeListKeys({
    items: sorted, page: browsePage, setPage: setBrowsePage, activeIndex: browseActive, setActiveIndex: setBrowseActive,
    onPick: pick, onClose: () => setBrowseOpen(false),
  });
  const searchKeys = makeListKeys({
    items: matches, page: searchPage, setPage: setSearchPage, activeIndex: searchActive, setActiveIndex: setSearchActive,
    onPick: pick, onClose: () => setSearchOpen(false),
  });

  return (
    <div className={`cp-root${disabled ? ' is-disabled' : ''}`}>
      <div className="cp-field" ref={browseRef}>
        <span className="cp-label" id={`${uid}-browse-label`}>Customer account</span>
        <button
          type="button"
          className={`cp-trigger${browseOpen ? ' is-open' : ''}`}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={browseOpen}
          aria-labelledby={`${uid}-browse-label`}
          aria-controls={browseOpen ? `${uid}-browse` : undefined}
          aria-activedescendant={browseOpen ? `${uid}-browse-opt-${browseActive}` : undefined}
          onClick={() => (browseOpen ? setBrowseOpen(false) : openBrowse())}
          onKeyDown={(e) => {
            if (!browseOpen && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openBrowse(); return; }
            if (browseOpen) browseKeys(e);
          }}
        >
          {selected ? (
            <span className="cp-trigger-value">
              <span className="cp-name">{customerName(selected)}</span>
              <span className="cp-email">{selected.email || 'No email on file'}</span>
            </span>
          ) : (
            <span className="cp-placeholder">{sorted.length ? 'Choose a customer' : 'No customer accounts yet'}</span>
          )}
          <ChevronDown size={18} className="cp-chevron" aria-hidden="true" />
        </button>
        {browseOpen && (
          <CustomerList
            id={`${uid}-browse`} label="Customer accounts" items={sorted}
            page={browsePage} setPage={setBrowsePage} selectedId={value}
            activeIndex={browseActive} setActiveIndex={setBrowseActive} onPick={pick}
            emptyText="No customer accounts yet."
          />
        )}
      </div>

      <div className="cp-field" ref={searchRef}>
        <label className="cp-label" htmlFor={`${uid}-search`}>Search by name</label>
        <div className="cp-search">
          <Search size={17} className="cp-search-icon" aria-hidden="true" />
          <input
            id={`${uid}-search`}
            type="search"
            className="cp-search-input"
            placeholder="Type a customer's name"
            value={query}
            disabled={disabled}
            autoComplete="off"
            role="combobox"
            aria-expanded={searchOpen && Boolean(query.trim())}
            aria-controls={`${uid}-search-list`}
            aria-activedescendant={searchOpen && matches.length ? `${uid}-search-list-opt-${searchActive}` : undefined}
            onChange={(e) => { setQuery(e.target.value); setSearchPage(0); setSearchActive(0); setSearchOpen(true); setBrowseOpen(false); }}
            onFocus={() => { if (query.trim()) setSearchOpen(true); }}
            onKeyDown={searchKeys}
          />
          {query && (
            <button type="button" className="cp-clear" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(''); setSearchOpen(false); }}>
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        {searchOpen && query.trim() && (
          <CustomerList
            id={`${uid}-search-list`} label="Matching customers" items={matches}
            page={searchPage} setPage={setSearchPage} selectedId={value}
            activeIndex={searchActive} setActiveIndex={setSearchActive} onPick={pick}
            emptyText={`No customer matches “${query.trim()}”.`}
          />
        )}
      </div>
    </div>
  );
}
