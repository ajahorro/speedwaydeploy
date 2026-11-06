import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search, X } from 'lucide-react';

/**
 * Everything an administrator can change in the Business Hub, so the search box can jump straight to it.
 * tab: which Business Hub tab holds it; panel: a collapsed panel to open first (Services & Promos, Terms & Policies);
 * about: an About & Map section to open; target: the element to scroll to and highlight.
 */
export const HUB_SEARCH_INDEX = [
  // Business Profile
  { label: 'Business name', tab: 'profile', target: '#business-name', words: 'shop name brand title' },
  { label: 'Contact number', tab: 'profile', target: '#business-contact-number', words: 'phone mobile telephone call' },
  { label: 'Email address', tab: 'profile', target: '#business-email-address', words: 'email contact mail' },
  { label: 'Business address', tab: 'profile', target: '#business-address', words: 'address location street city' },
  { label: 'QR account name', tab: 'profile', target: '#business-qr-account-name', words: 'gcash maya qr payment recipient account name' },
  { label: 'QR account number', tab: 'profile', target: '#business-qr-account-number', words: 'gcash maya qr payment recipient account number' },
  { label: 'QR photo', tab: 'profile', target: '#business-qr-photo', words: 'gcash maya qr code image payment upload' },
  { label: 'Frequently asked questions', tab: 'profile', target: '[data-tour="hub-faq"]', words: 'faq questions answers help' },
  // About & Map
  { label: 'Top banner photo', tab: 'about', about: 'hero', target: '[data-tour="about-sec-hero"]', words: 'hero banner background photo image header top' },
  { label: 'About text', tab: 'about', about: 'text', target: '[data-tour="about-sec-text"]', words: 'about us heading paragraph story description' },
  { label: 'About highlights', tab: 'about', about: 'cards', target: '[data-tour="about-sec-cards"]', words: 'cards icons protection performance quality reliability features' },
  { label: 'About photos and layout', tab: 'about', about: 'photos', target: '[data-tour="about-sec-photos"]', words: 'gallery pictures captions layout mosaic slideshow grid story' },
  { label: 'Map pin', tab: 'about', about: 'map', target: '[data-tour="about-sec-map"]', words: 'map pin location find us directions address' },
  // Schedule Rules
  { label: 'Minimum notice before booking', tab: 'schedule', target: '#business-lead-time', words: 'lead time advance notice hours before' },
  { label: 'Latest booking window', tab: 'schedule', target: '#business-advance-days', words: 'how far ahead days future booking window' },
  { label: 'Total bays available', tab: 'schedule', target: '#business-slots-per-hour', words: 'bays slots capacity per hour' },
  { label: 'Vehicles per technician', tab: 'schedule', target: '#business-max-vehicles-per-staff', words: 'staff technician capacity limit cars' },
  { label: 'Open 24/7', tab: 'schedule', target: '#business-is-24-7', words: 'always open 24 hours weekly schedule' },
  { label: 'Opening time', tab: 'schedule', target: '#business-opening-hour', words: 'open hours start time weekly schedule' },
  { label: 'Closing time', tab: 'schedule', target: '#business-closing-hour', words: 'close hours end time weekly schedule' },
  { label: 'Closures and holidays', tab: 'schedule', target: '[data-tour="hub-closures"]', words: 'closed day holiday block hours vacation off' },
  // Services & Promos
  { label: 'Existing services', tab: 'services', panel: 'existing', target: '[data-tour="hub-svc-existing"]', words: 'services catalog prices edit archive packages' },
  { label: 'Add a service', tab: 'services', panel: 'add', target: '[data-tour="hub-svc-add"]', words: 'new service create package price' },
  { label: 'Vehicle types', tab: 'services', panel: 'vehicle', target: '[data-tour="hub-svc-vehicle"]', words: 'vehicle car sedan suv motorcycle types sizes' },
  { label: 'Promos and promo codes', tab: 'services', panel: 'promos', target: '[data-tour="hub-promos"]', words: 'promo discount code voucher sale deal' },
  // Terms & Policies
  { label: 'Terms and conditions', tab: 'terms', panel: 'terms', target: '[data-tour="hub-terms-terms"]', words: 'terms conditions rules agreement' },
  { label: 'Privacy & security policy', tab: 'terms', panel: 'security', target: '[data-tour="hub-terms-security"]', words: 'privacy security data protection policy dpo' },
  { label: 'Payment policy', tab: 'terms', panel: 'payments', target: '[data-tour="hub-terms-payments"]', words: 'downpayment down payment deposit percent policy' },
];

const TAB_LABELS = { profile: 'Business Profile', about: 'About & Map', schedule: 'Schedule Rules', services: 'Services & Promos', terms: 'Terms & Policies' };

const norm = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9/& ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Search box under the Business Hub heading: type what you want to change, pick a result, land on that setting. */
export default function HubSearch({ onPick }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const listId = useId();
  // Filipino names of the settings too, so a search in Tagalog finds them (same catalog the page translator uses)
  const [catalog, setCatalog] = useState(null);
  useEffect(() => {
    let alive = true;
    import('../../i18n/tl.json').then((mod) => { if (alive) setCatalog(mod.default || mod); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const results = useMemo(() => {
    const q = norm(query);
    if (!q) return [];
    const terms = q.split(' ');
    return HUB_SEARCH_INDEX
      .map((entry) => {
        const label = norm(entry.label);
        const tl = catalog ? norm(catalog[entry.label]) : '';
        const hay = `${label} ${norm(entry.words)} ${tl}`;
        if (!terms.every((t) => hay.includes(t))) return null;
        const score = (label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2);
        return { entry, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
      .slice(0, 8)
      .map((r) => r.entry);
  }, [query, catalog]);

  const pick = (entry) => {
    if (!entry) return;
    onPick(entry);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0))); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); pick(results[active]); }
    else if (event.key === 'Escape') { setQuery(''); setOpen(false); }
  };

  const showList = open && query.trim().length > 0;

  return (
    <div className="ui-root relative w-full max-w-xl" role="search">
      <label htmlFor={`${listId}-input`} className="sr-only">Search Business Hub settings</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          maxLength={60}
          value={query}
          placeholder="Search settings, e.g. opening time, promo, map pin"
          onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          className="h-10 w-full rounded-[2px] border border-input bg-background pl-9 pr-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 cursor-pointer place-items-center rounded-[2px] text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </div>
      {showList && (
        <ul id={listId} role="listbox" aria-label="Matching settings"
          className="absolute inset-x-0 top-full z-40 m-0 mt-1 grid max-h-80 list-none gap-0 overflow-y-auto rounded-[2px] border bg-popover p-1 text-popover-foreground shadow-lg">
          {results.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-muted-foreground">No setting matches that. Try another word.</li>
          ) : results.map((entry, index) => (
            <li
              key={`${entry.tab}-${entry.label}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(e) => { e.preventDefault(); pick(entry); }}
              onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-[2px] px-3 py-2 text-sm ${index === active ? 'bg-accent text-accent-foreground' : ''}`}
            >
              <span className="grid min-w-0">
                <span className="font-medium">{entry.label}</span>
                <span className="text-xs text-muted-foreground">{TAB_LABELS[entry.tab]}</span>
              </span>
              {index === active && <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
