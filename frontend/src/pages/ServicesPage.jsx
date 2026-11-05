import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Calendar, ChevronRight, Clock, Facebook, Image as ImageIcon,
  Instagram, Menu, Search, Twitter, X as XIcon
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useConfig } from '../context/ConfigContext';
import { getServiceCatalog } from '../data/servicesCatalog';
import { AuthButtons, MobileMenu, SiteFooter } from '../features/landing/LandingParts';
import {
  CATEGORY_BLURBS, SERVICE_PHOTO_SLOTS, photosForCategory, photosForService
} from '../config/servicePhotos';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Public services catalog (/services). One category at a time, chosen from the tabs (kept in the URL as
 * ?category=… so links and the back button work). Searching looks across every category. Each service
 * opens a detail view with its photo gallery, prices for every vehicle type and a booking button.
 * Matches the landing page: always dark, same header, same footer. Photos: config/servicePhotos.js.
 */

const DASHBOARD_ROUTES = { ADMIN: '/admin', STAFF: '/staff', CUSTOMER: '/customer' };

const formatPrice = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString() : String(value ?? '');
};

const lowestPrice = (prices = {}) => {
  const values = Object.values(prices).map(Number).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
};

const sameEverywhere = (prices = {}) => new Set(Object.values(prices).map(Number)).size <= 1;

/**
 * The Business Hub saves a service once per vehicle type (Basic Carwash for Sedan, for SUV, …), and the catalog keeps
 * each as its own entry. For customers that is one service, so entries with the same name in a category become one
 * card whose price list covers every vehicle type.
 */
const mergeSameNamed = (catalog) => Object.fromEntries(Object.entries(catalog).map(([category, list]) => {
  const byName = new Map();
  for (const service of list || []) {
    const key = String(service?.name || '').trim().toLowerCase();
    if (!key) continue;
    const seen = byName.get(key);
    if (!seen) { byName.set(key, { ...service, prices: { ...(service.prices || {}) } }); continue; }
    Object.assign(seen.prices, service.prices || {});
    if (!seen.desc && service.desc) seen.desc = service.desc;
    if (!seen.estTime && service.estTime) seen.estTime = service.estTime;
    if (!seen.image_url && service.image_url) seen.image_url = service.image_url;
  }
  return [category, [...byName.values()]];
}));

function PhotoSlot({ src, alt, className = '', label = 'Photo coming soon' }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <div className={`sp-photo ${className}`}>
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className={`sp-photo sp-photo-empty ${className}`} aria-label={label}>
      <ImageIcon size={22} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function ServiceTile({ service, onOpen }) {
  const photos = photosForService(service);
  const from = lowestPrice(service.prices);
  return (
    <button type="button" className="sp-card" onClick={() => onOpen(service)}>
      <PhotoSlot src={photos[0]} alt={service.name} className="sp-card-photo" />
      <div className="sp-card-body">
        <h3 className="sp-card-title">{service.name}</h3>
        <p className="sp-card-desc">{service.desc}</p>
        <div className="sp-card-meta">
          {from !== null && (
            <span className="sp-price">
              {sameEverywhere(service.prices) ? '' : 'From '}₱{formatPrice(from)}
            </span>
          )}
          {service.estTime && (
            <span className="sp-time"><Clock size={13} aria-hidden="true" /> {service.estTime}</span>
          )}
        </div>
        <span className="sp-card-more">View details <ChevronRight size={14} aria-hidden="true" /></span>
      </div>
    </button>
  );
}

function ServiceDetail({ service, category, onClose, onBook }) {
  const open = Boolean(service);
  const photos = service ? photosForService(service) : [];
  const slots = Array.from({ length: Math.max(SERVICE_PHOTO_SLOTS, photos.length) }, (_, i) => photos[i] || null);
  const prices = Object.entries(service?.prices || {});
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="landing-ui sp-dialog border-border bg-background text-foreground sm:max-w-2xl">
        {service && (
          <>
            <DialogHeader>
              <span className="sp-eyebrow">{category}</span>
              <DialogTitle className="text-xl font-black uppercase">{service.name}</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed text-muted-foreground">{service.desc}</DialogDescription>
            </DialogHeader>

            <div className="sp-gallery">
              {slots.map((src, i) => (
                <PhotoSlot key={src || `slot-${i}`} src={src} alt={`${service.name} photo ${i + 1}`} className={i === 0 ? 'sp-gallery-main' : ''} />
              ))}
            </div>

            {service.estTime && (
              <p className="sp-detail-time"><Clock size={15} aria-hidden="true" /> Takes about {service.estTime}</p>
            )}

            <div>
              <h4 className="sp-detail-heading">Price by vehicle type</h4>
              <ul className="sp-price-table">
                {prices.map(([type, price]) => (
                  <li key={type}><span>{type}</span><strong>₱{formatPrice(price)}</strong></li>
                ))}
              </ul>
              {Array.isArray(service.requires) && service.requires.length > 0 && (
                <p className="sp-note">Only available together with: {service.requires.join(', ')}.</p>
              )}
            </div>

            <button type="button" className="sp-btn sp-btn-primary sp-btn-block" onClick={onBook}>
              <Calendar size={17} aria-hidden="true" /> Book this service
            </button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function ServicesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, profile, signOut, isInitialized, loading: authLoading } = useAuth();
  const { settings } = useConfig();
  const businessName = settings?.BUSINESS_NAME || 'COMAR GARAGE';
  const authPending = Boolean(user && (!isInitialized || authLoading));

  // The catalog follows the Business Hub: rebuild it whenever the shop config arrives or changes.
  const [catalog, setCatalog] = useState(() => mergeSameNamed(getServiceCatalog()));
  useEffect(() => {
    const refresh = () => setCatalog(mergeSameNamed(getServiceCatalog()));
    refresh();
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [settings]);

  const categories = useMemo(
    () => Object.entries(catalog).filter(([, list]) => list.length > 0).map(([name]) => name),
    [catalog]
  );

  const requested = searchParams.get('category');
  const activeCategory = categories.includes(requested) ? requested : categories[0];
  const activeIndex = categories.indexOf(activeCategory);

  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [selected, setSelected] = useState(null); // { service, category }

  // The app shell locks page scrolling; public pages opt back in (same as the landing page).
  useEffect(() => {
    const nodes = [document.documentElement, document.body, document.getElementById('root')].filter(Boolean);
    nodes.forEach((n) => n.classList.add('landing-scroll'));
    window.scrollTo(0, 0);
    return () => nodes.forEach((n) => n.classList.remove('landing-scroll'));
  }, []);

  const chooseCategory = useCallback((name) => {
    setQuery('');
    setSearchParams(name ? { category: name } : {}, { replace: false });
    document.getElementById('sp-catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [setSearchParams]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return categories
      .map((category) => [category, catalog[category].filter((s) => (
        s.name?.toLowerCase().includes(q)
        || s.desc?.toLowerCase().includes(q)
        || Object.keys(s.prices || {}).some((type) => type.toLowerCase().includes(q))
      ))])
      .filter(([, list]) => list.length > 0);
  }, [query, categories, catalog]);

  const goToDashboard = () => {
    if (!user) { navigate('/login'); return; }
    if (authPending) return;
    navigate(DASHBOARD_ROUTES[String(profile?.role || '').toUpperCase()] || '/customer');
  };

  const book = () => {
    setSelected(null);
    if (!user) { navigate('/login'); return; }
    const role = String(profile?.role || '').toUpperCase();
    navigate(role === 'CUSTOMER' || !role ? '/customer/book' : (DASHBOARD_ROUTES[role] || '/customer'));
  };

  // Landing page sections are reached through router state; the landing page scrolls to them on arrival.
  const goHome = (section) => navigate('/', section ? { state: { scrollTo: section } } : undefined);
  const NAV_LINKS = [
    { label: 'Home', id: 'home', go: () => goHome() },
    { label: 'About', id: 'about', go: () => goHome('about') },
    { label: 'Services', id: 'services', go: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { label: 'FAQ', id: 'faq', go: () => goHome('faq') },
    { label: 'Contact', id: 'contact', go: () => goHome('contact') },
  ];
  const FOOTER_LINKS = [
    { label: 'Home', id: 'home', go: () => goHome() },
    { label: 'About Us', id: 'about', go: () => goHome('about') },
    { label: 'Services', id: 'services', go: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { label: 'FAQ', id: 'faq', go: () => goHome('faq') },
    { label: 'Book Appointment', id: 'book', go: book },
  ];
  const runLink = (links) => (id) => { setMenuOpen(false); links.find((l) => l.id === id)?.go(); };

  const renderGrid = (category, list) => (
    <div className="sp-grid">
      {list.map((service, i) => (
        <ServiceTile key={service.id || `${category}-${i}`} service={service} onOpen={(s) => setSelected({ service: s, category })} />
      ))}
    </div>
  );

  const prev = activeIndex > 0 ? categories[activeIndex - 1] : null;
  const next = activeIndex >= 0 && activeIndex < categories.length - 1 ? categories[activeIndex + 1] : null;
  const activeList = catalog[activeCategory] || [];
  const categoryPhoto = photosForCategory(activeCategory)[0];

  return (
    <div className="sp-page">
      <style>{SERVICES_CSS}</style>

      <header className="sp-header">
        <button type="button" className="sp-logo" onClick={() => goHome()} aria-label={`${businessName} home`}>
          <img src="/comarlogo-Photoroom.png" alt={businessName} />
        </button>
        <nav className="sp-nav" aria-label="Main">
          {NAV_LINKS.map((link) => (
            <button
              key={link.id}
              type="button"
              onClick={link.go}
              className={`sp-nav-link ${link.id === 'services' ? 'is-active' : ''}`}
              aria-current={link.id === 'services' ? 'page' : undefined}
            >
              {link.label}
            </button>
          ))}
        </nav>
        <div className="sp-actions">
          <AuthButtons user={user} pending={authPending} onAuth={goToDashboard} onSignOut={() => signOut()} />
        </div>
        <button type="button" className="sp-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open navigation menu">
          <Menu size={20} />
        </button>
      </header>

      <MobileMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        links={NAV_LINKS}
        onNavigate={runLink(NAV_LINKS)}
        user={user}
        pending={authPending}
        onAuth={() => { setMenuOpen(false); goToDashboard(); }}
        onSignOut={() => { setMenuOpen(false); signOut(); }}
      />

      <section className="sp-hero">
        <div className="sp-container">
          <button type="button" className="sp-back" onClick={() => goHome()}>
            <ArrowLeft size={15} aria-hidden="true" /> Back to home
          </button>
          <h1>Our Services</h1>
          <p>Pick a category to see what we offer, then open any service for photos and the price for your vehicle.</p>
          <div className="sp-search">
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all services…"
              aria-label="Search all services"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><XIcon size={16} /></button>
            )}
          </div>
        </div>
      </section>

      <div className="sp-tabs-bar" id="sp-catalog">
        <div className="sp-container sp-tabs" role="tablist" aria-label="Service categories">
          {categories.map((name) => {
            const isActive = !searchResults && name === activeCategory;
            return (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`sp-tab ${isActive ? 'is-active' : ''}`}
                onClick={() => chooseCategory(name)}
              >
                {name} <span className="sp-tab-count">{catalog[name].length}</span>
              </button>
            );
          })}
        </div>
      </div>

      <main className="sp-container sp-main">
        {searchResults ? (
          <>
            <div className="sp-results-head">
              <h2>{searchResults.reduce((n, [, l]) => n + l.length, 0)} results for “{query.trim()}”</h2>
              <button type="button" className="sp-btn sp-btn-ghost" onClick={() => setQuery('')}>Clear search</button>
            </div>
            {searchResults.length === 0 ? (
              <div className="sp-empty">
                <Search size={26} aria-hidden="true" />
                <p>No service matches that. Try another word, or browse the categories above.</p>
              </div>
            ) : searchResults.map(([category, list]) => (
              <section key={category} className="sp-result-group">
                <h3 className="sp-group-title">{category}</h3>
                {renderGrid(category, list)}
              </section>
            ))}
          </>
        ) : activeCategory ? (
          <section aria-labelledby="sp-category-title">
            <div className="sp-category-head">
              <PhotoSlot src={categoryPhoto} alt={activeCategory} className="sp-category-photo" label="Category photo coming soon" />
              <div className="sp-category-text">
                <span className="sp-eyebrow">Category {activeIndex + 1} of {categories.length}</span>
                <h2 id="sp-category-title">{activeCategory}</h2>
                {CATEGORY_BLURBS[activeCategory] && <p>{CATEGORY_BLURBS[activeCategory]}</p>}
                <span className="sp-count">{activeList.length} {activeList.length === 1 ? 'service' : 'services'}</span>
              </div>
            </div>

            {renderGrid(activeCategory, activeList)}

            <div className="sp-pager">
              {prev ? (
                <button type="button" className="sp-btn sp-btn-ghost" onClick={() => chooseCategory(prev)}>
                  <ArrowLeft size={16} aria-hidden="true" /> {prev}
                </button>
              ) : <span />}
              {next && (
                <button type="button" className="sp-btn sp-btn-ghost" onClick={() => chooseCategory(next)}>
                  Next: {next} <ArrowRight size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </section>
        ) : (
          <div className="sp-empty"><p>Services are loading…</p></div>
        )}

        <section className="sp-cta">
          <h2>Ready to book?</h2>
          <p>Choose your vehicle, pick your services and reserve a time in a couple of minutes.</p>
          <button type="button" className="sp-btn sp-btn-primary" onClick={book}>
            <Calendar size={17} aria-hidden="true" /> Book an appointment
          </button>
        </section>
      </main>

      <SiteFooter
        businessName={businessName}
        links={FOOTER_LINKS}
        onNavigate={runLink(FOOTER_LINKS)}
        socials={[
          { label: 'Facebook', icon: Facebook },
          { label: 'Instagram', icon: Instagram },
          { label: 'Twitter', icon: Twitter },
        ]}
      />

      <ServiceDetail
        service={selected?.service}
        category={selected?.category}
        onClose={() => setSelected(null)}
        onBook={book}
      />
    </div>
  );
}

const SERVICES_CSS = `
.sp-page { --sp-bg:#0A0B0D; --sp-card:#15171A; --sp-line:rgba(255,255,255,.09); --sp-muted:rgba(255,255,255,.62); --sp-red:#C41F2B;
  background:var(--sp-bg); color:#fff; min-height:100vh; display:flex; flex-direction:column; }
.sp-container { width:100%; max-width:1140px; margin:0 auto; padding:0 clamp(1rem,4vw,1.5rem); box-sizing:border-box; }

.sp-header { position:fixed; inset:0 0 auto 0; height:70px; z-index:1000; display:flex; align-items:center; justify-content:space-between;
  gap:1rem; padding:0 clamp(1rem,5vw,3.5rem); background:rgba(10,11,13,.94); backdrop-filter:blur(16px); border-bottom:1px solid var(--sp-line); }
.sp-logo { background:none; border:0; padding:0; cursor:pointer; flex:1; display:flex; }
.sp-logo img { width:clamp(130px,12vw,180px); height:auto; display:block; }
.sp-nav { display:flex; gap:clamp(1.2rem,2.2vw,2.5rem); }
.sp-nav-link { background:none; border:0; color:rgba(255,255,255,.82); font-size:.8rem; font-weight:900; text-transform:uppercase;
  letter-spacing:1px; cursor:pointer; padding:.5rem 0; }
.sp-nav-link:hover, .sp-nav-link.is-active { color:var(--sp-red); }
.sp-actions { flex:1; display:flex; justify-content:flex-end; }
.sp-menu-btn { display:none; align-items:center; justify-content:center; width:42px; height:42px; border-radius:8px; cursor:pointer;
  background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.18); color:#fff; }
@media (max-width:768px) {
  .sp-nav, .sp-actions { display:none; }
  .sp-menu-btn { display:inline-flex; }
}

.sp-hero { padding:110px 0 2.5rem; text-align:center; border-bottom:1px solid var(--sp-line);
  background:radial-gradient(ellipse at 50% 15%, rgba(196,31,43,.16) 0%, transparent 70%); }
.sp-hero h1 { font-size:clamp(1.9rem,5vw,3rem); font-weight:950; text-transform:uppercase; margin:0 0 .75rem; letter-spacing:.5px; }
.sp-hero p { max-width:600px; margin:0 auto 1.75rem; color:var(--sp-muted); font-size:.95rem; line-height:1.6; }
.sp-back { display:inline-flex; align-items:center; gap:.4rem; background:none; border:0; color:var(--sp-red); font-size:.78rem;
  font-weight:800; text-transform:uppercase; letter-spacing:.5px; cursor:pointer; margin-bottom:1rem; }
.sp-search { position:relative; max-width:520px; margin:0 auto; display:flex; align-items:center; }
.sp-search > svg { position:absolute; left:1rem; opacity:.5; pointer-events:none; }
.sp-search input { width:100%; padding:.85rem 2.75rem; border-radius:10px; background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.14); color:#fff; font-size:.92rem; font-weight:600; outline:none; }
.sp-search input::-webkit-search-cancel-button { display:none; }
.sp-search input:focus { border-color:var(--sp-red); box-shadow:0 0 0 3px rgba(196,31,43,.2); }
.sp-search > button { position:absolute; right:.6rem; background:none; border:0; color:#fff; opacity:.6; cursor:pointer; padding:.35rem; display:flex; }

.sp-tabs-bar { position:sticky; top:70px; z-index:900; background:rgba(14,16,19,.96); backdrop-filter:blur(12px);
  border-bottom:1px solid var(--sp-line); scroll-margin-top:70px; }
.sp-tabs { display:flex; gap:.55rem; overflow-x:auto; padding-top:.8rem; padding-bottom:.8rem; scrollbar-width:none; }
.sp-tabs::-webkit-scrollbar { display:none; }
.sp-tab { flex:none; display:inline-flex; align-items:center; gap:.45rem; padding:.55rem 1rem; border-radius:999px; cursor:pointer;
  font-size:.74rem; font-weight:800; text-transform:uppercase; letter-spacing:.5px; white-space:nowrap;
  background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.13); color:rgba(255,255,255,.78); transition:all .2s ease; }
.sp-tab:hover { border-color:var(--sp-red); color:#fff; }
.sp-tab.is-active { background:var(--sp-red); border-color:var(--sp-red); color:#fff; box-shadow:0 4px 14px rgba(196,31,43,.35); }
.sp-tab-count { font-size:.68rem; opacity:.7; }

.sp-main { flex:1; padding-top:2.25rem; padding-bottom:4rem; }
.sp-eyebrow { display:block; font-size:.7rem; font-weight:900; letter-spacing:1px; text-transform:uppercase; color:#ff4d5a; margin-bottom:.35rem; }

.sp-photo { position:relative; overflow:hidden; background:#1b1d21; }
.sp-photo img { width:100%; height:100%; object-fit:cover; display:block; }
.sp-photo-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.4rem; color:rgba(255,255,255,.38);
  border:1px dashed rgba(255,255,255,.16); font-size:.65rem; font-weight:800; text-transform:uppercase; letter-spacing:.8px; text-align:center; padding:.5rem; }

.sp-category-head { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(0,1fr); gap:1.5rem; align-items:center; margin-bottom:2rem; }
.sp-category-photo { aspect-ratio:16/7; border-radius:14px; }
.sp-category-text h2 { font-size:clamp(1.5rem,3.5vw,2.1rem); font-weight:950; text-transform:uppercase; margin:0 0 .5rem; }
.sp-category-text p { color:var(--sp-muted); margin:0 0 .75rem; line-height:1.55; font-size:.95rem; }
.sp-count { font-size:.75rem; font-weight:800; text-transform:uppercase; color:rgba(255,255,255,.5); }
@media (max-width:720px) { .sp-category-head { grid-template-columns:1fr; } }

.sp-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%,290px),1fr)); gap:1.25rem; }
.sp-card { display:flex; flex-direction:column; text-align:left; padding:0; cursor:pointer; color:inherit; font:inherit;
  background:var(--sp-card); border:1px solid rgba(255,255,255,.08); border-radius:14px; overflow:hidden;
  transition:transform .25s ease, border-color .25s ease, box-shadow .25s ease; }
.sp-card:hover, .sp-card:focus-visible { transform:translateY(-3px); border-color:rgba(196,31,43,.55); box-shadow:0 12px 30px rgba(0,0,0,.45); outline:none; }
.sp-card-photo { aspect-ratio:4/3; border-width:0 0 1px 0; }
.sp-card-body { display:flex; flex-direction:column; flex:1; padding:1.1rem 1.2rem 1.2rem; }
.sp-card-title { font-size:.98rem; font-weight:900; text-transform:uppercase; margin:0 0 .45rem; line-height:1.3; }
.sp-card-desc { color:var(--sp-muted); font-size:.86rem; line-height:1.5; margin:0 0 1rem; flex:1;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.sp-card-meta { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.5rem; margin-bottom:.8rem; }
.sp-price { font-weight:950; font-size:1.05rem; color:#fff; }
.sp-time { display:inline-flex; align-items:center; gap:.3rem; font-size:.75rem; font-weight:700; color:rgba(255,255,255,.55); }
.sp-card-more { display:inline-flex; align-items:center; gap:.2rem; font-size:.72rem; font-weight:900; text-transform:uppercase;
  letter-spacing:.8px; color:var(--sp-red); }

.sp-pager { display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-top:2.5rem; }
.sp-results-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-bottom:1.5rem; }
.sp-results-head h2 { margin:0; font-size:1.15rem; font-weight:900; }
.sp-result-group { margin-bottom:2.5rem; }
.sp-group-title { font-size:.85rem; font-weight:900; text-transform:uppercase; letter-spacing:1px; color:rgba(255,255,255,.7); margin:0 0 1rem; }
.sp-empty { text-align:center; padding:4rem 1rem; color:var(--sp-muted); display:flex; flex-direction:column; align-items:center; gap:.75rem; }

.sp-btn { display:inline-flex; align-items:center; justify-content:center; gap:.5rem; border-radius:8px; cursor:pointer;
  font-size:.8rem; font-weight:900; text-transform:uppercase; letter-spacing:.8px; padding:.8rem 1.3rem; transition:all .2s ease; }
.sp-btn-primary { background:var(--sp-red); color:#fff; border:0; box-shadow:0 6px 20px rgba(196,31,43,.35); }
.sp-btn-primary:hover { transform:translateY(-1px); box-shadow:0 8px 24px rgba(196,31,43,.5); }
.sp-btn-ghost { background:rgba(255,255,255,.05); color:#fff; border:1px solid rgba(255,255,255,.16); }
.sp-btn-ghost:hover { border-color:var(--sp-red); }
.sp-btn-block { width:100%; padding:.95rem; }

.sp-cta { margin-top:4rem; text-align:center; padding:clamp(2rem,4vw,3rem); border-radius:16px;
  background:radial-gradient(ellipse at 50% 50%, rgba(196,31,43,.18) 0%, rgba(14,16,19,.95) 100%); border:1px solid rgba(196,31,43,.3); }
.sp-cta h2 { margin:0 0 .6rem; font-size:clamp(1.25rem,2.6vw,1.8rem); font-weight:950; text-transform:uppercase; }
.sp-cta p { margin:0 auto 1.5rem; max-width:520px; color:var(--sp-muted); line-height:1.6; }

.sp-dialog { max-height:min(90vh, 90dvh) !important; overflow-y:auto !important; overscroll-behavior:contain; }
.sp-gallery { display:grid; grid-template-columns:2fr 1fr; grid-auto-rows:minmax(90px,auto); gap:.6rem; }
.sp-gallery .sp-photo { border-radius:10px; aspect-ratio:4/3; }
.sp-gallery .sp-gallery-main { grid-row:span 2; aspect-ratio:auto; min-height:220px; }
@media (max-width:520px) { .sp-gallery { grid-template-columns:1fr 1fr; } .sp-gallery .sp-gallery-main { grid-column:span 2; grid-row:auto; min-height:190px; } }
.sp-detail-time { display:flex; align-items:center; gap:.45rem; margin:0; font-size:.85rem; font-weight:700; color:rgba(255,255,255,.75); }
.sp-detail-heading { font-size:.72rem; font-weight:900; text-transform:uppercase; letter-spacing:1px; color:rgba(255,255,255,.55); margin:0 0 .5rem; }
.sp-price-table { list-style:none; margin:0; padding:0; border:1px solid rgba(255,255,255,.08); border-radius:10px; overflow:hidden; }
.sp-price-table li { display:flex; justify-content:space-between; padding:.6rem .9rem; font-size:.88rem; border-bottom:1px solid rgba(255,255,255,.06); }
.sp-price-table li:last-child { border-bottom:0; }
.sp-price-table li span { color:rgba(255,255,255,.7); font-weight:700; text-transform:uppercase; font-size:.78rem; }
.sp-note { margin:.6rem 0 0; font-size:.8rem; color:rgba(255,255,255,.6); }
`;
