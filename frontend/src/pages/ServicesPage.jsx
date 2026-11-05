import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  ChevronRight,
  ArrowLeft,
  Sparkles,
  Calendar,
  Layers,
  CheckCircle2,
  Phone,
  Mail,
  MapPin,
  Clock,
  X as XIcon,
  Facebook,
  Instagram,
  Twitter
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useConfig } from '../context/ConfigContext';
import { getServiceCatalog } from '../data/servicesCatalog';
import { ServiceCard, AuthButtons, MobileMenu, SiteFooter } from '../features/landing/LandingParts';
import { ThemeToggle } from '../components/ThemeToggle';

export default function ServicesPage() {
  const navigate = useNavigate();
  const { user, profile, loading: authLoading, signOut } = useAuth();
  const { config } = useConfig();
  const businessName = config?.business_name || 'Comar Garage';

  const [catalog, setCatalog] = useState(() => getServiceCatalog());
  const [activeCategory, setActiveCategory] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    window.scrollTo(0, 0);
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const categories = useMemo(() => {
    return ['ALL', ...Object.keys(catalog)];
  }, [catalog]);

  const filteredCategories = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const result = {};

    Object.entries(catalog).forEach(([category, services]) => {
      if (activeCategory !== 'ALL' && activeCategory !== category) return;

      const matchingServices = services.filter((service) => {
        if (!q) return true;
        const nameMatch = service.name?.toLowerCase().includes(q);
        const descMatch = service.desc?.toLowerCase().includes(q);
        const typeMatch = Object.keys(service.prices || {}).some(t => t.toLowerCase().includes(q));
        return nameMatch || descMatch || typeMatch;
      });

      if (matchingServices.length > 0) {
        result[category] = matchingServices;
      }
    });

    return result;
  }, [catalog, activeCategory, searchQuery]);

  const totalFilteredServices = useMemo(() => {
    return Object.values(filteredCategories).reduce((sum, sList) => sum + sList.length, 0);
  }, [filteredCategories]);

  const formatPrice = (val) => Number(val || 0).toLocaleString();

  const handleAuthAction = () => {
    if (user?.id) {
      const role = String(profile?.role || '').toUpperCase();
      const routes = { ADMIN: '/admin', STAFF: '/staff', CUSTOMER: '/customer' };
      navigate(routes[role] || '/customer');
    } else {
      navigate('/login');
    }
  };

  const NAV_LINKS = [
    { label: 'Home', id: 'home', action: () => navigate('/') },
    { label: 'About', id: 'about', action: () => navigate('/#about') },
    { label: 'Services', id: 'services', active: true, action: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { label: 'FAQ', id: 'faq', action: () => navigate('/#faq') },
    { label: 'Contact', id: 'contact', action: () => navigate('/#contact') },
  ];

  const FOOTER_LINKS = [
    { label: 'Home', id: 'home', action: () => navigate('/') },
    { label: 'About Us', id: 'about', action: () => navigate('/#about') },
    { label: 'Services Catalog', id: 'services', action: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { label: 'FAQ', id: 'faq', action: () => navigate('/#faq') },
    { label: 'Book Appointment', id: 'book', action: () => navigate(user ? '/customer/book' : '/login') },
  ];

  const SOCIALS = [
    { label: 'Facebook', icon: Facebook },
    { label: 'Instagram', icon: Instagram },
    { label: 'Twitter', icon: Twitter },
  ];

  return (
    <div style={{ background: 'var(--admin-bg, #0A0B0D)', color: 'var(--admin-text-primary, #fff)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        .services-header {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 70px;
          background: rgba(10, 11, 13, 0.94);
          backdrop-filter: blur(16px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 clamp(1.2rem, 5vw, 3.5rem);
          z-index: 1000;
          transition: all 0.3s ease;
        }
        [data-theme='light'] .services-header {
          background: rgba(255, 255, 255, 0.95);
          border-bottom: 1px solid rgba(0, 0, 0, 0.08);
        }
        .services-pill {
          padding: 0.55rem 1.15rem;
          border-radius: 999px;
          font-size: 0.75rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          cursor: pointer;
          transition: all 0.25s ease;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.04);
          color: rgba(255, 255, 255, 0.75);
          white-space: nowrap;
        }
        [data-theme='light'] .services-pill {
          border-color: rgba(0, 0, 0, 0.1);
          background: #F3F4F6;
          color: #4B5563;
        }
        .services-pill:hover {
          border-color: var(--admin-brand, #C41F2B);
          color: var(--admin-brand, #C41F2B);
        }
        .services-pill.is-active {
          background: var(--admin-brand, #C41F2B) !important;
          border-color: var(--admin-brand, #C41F2B) !important;
          color: #fff !important;
          box-shadow: 0 4px 14px rgba(196, 31, 43, 0.35);
        }
        .category-services-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(min(100%, 330px), 1fr));
          gap: 1.5rem;
        }
        .services-search-input {
          width: 100%;
          padding: 0.85rem 1.25rem 0.85rem 3rem;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 10px;
          color: inherit;
          font-size: 0.9rem;
          font-weight: 600;
          outline: none;
          transition: all 0.2s ease;
        }
        [data-theme='light'] .services-search-input {
          background: #FFFFFF;
          border-color: rgba(0, 0, 0, 0.12);
          color: #111827;
        }
        .services-search-input:focus {
          border-color: var(--admin-brand, #C41F2B);
          box-shadow: 0 0 0 3px rgba(196, 31, 43, 0.15);
        }
      `}</style>

      {/* ── TOP HEADER ── */}
      <header className="services-header">
        <div style={{ flex: 1 }}>
          <div onClick={() => navigate('/')} style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
            <img
              src="/comarlogo-Photoroom.png"
              alt={businessName}
              style={{ width: 'clamp(140px, 12vw, 180px)', height: 'auto', display: 'block' }}
            />
          </div>
        </div>

        {/* Desktop Nav */}
        <nav className="desktop-nav" style={{ display: 'flex', gap: '1.75rem', alignItems: 'center' }}>
          {NAV_LINKS.map(link => (
            <button
              key={link.id}
              type="button"
              onClick={link.action}
              style={{
                background: 'none',
                border: 'none',
                color: link.active ? 'var(--admin-brand, #C41F2B)' : 'inherit',
                fontSize: '0.85rem',
                fontWeight: link.active ? '900' : '700',
                textTransform: 'uppercase',
                letterSpacing: '1px',
                cursor: 'pointer',
                opacity: link.active ? 1 : 0.75,
                transition: 'all 0.2s ease'
              }}
            >
              {link.label}
            </button>
          ))}
        </nav>

        {/* Desktop Actions */}
        <div className="desktop-actions" style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', alignItems: 'center' }}>
          <ThemeToggle variant="icon" />
          <AuthButtons user={user} pending={authLoading} onAuth={handleAuthAction} onSignOut={() => signOut()} />
        </div>

        {/* Mobile menu button */}
        <button
          className="three-lines-btn"
          onClick={() => setMenuOpen(o => !o)}
          aria-label="Toggle navigation menu"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '8px',
            padding: '0.5rem',
            color: 'inherit',
            cursor: 'pointer'
          }}
        >
          {menuOpen ? <XIcon size={20} /> : <Layers size={20} />}
        </button>
      </header>

      {/* Mobile Drawer */}
      <MobileMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        links={NAV_LINKS.map(l => ({ label: l.label, id: l.id }))}
        onNavigate={(id) => {
          setMenuOpen(false);
          const item = NAV_LINKS.find(l => l.id === id);
          if (item?.action) item.action();
        }}
        user={user}
        authPending={authLoading}
        onAuth={() => { setMenuOpen(false); handleAuthAction(); }}
        onSignOut={() => { setMenuOpen(false); signOut(); }}
      />

      {/* ── HERO BANNER ── */}
      <section style={{ paddingTop: '110px', paddingBottom: '3rem', background: 'radial-gradient(ellipse at 50% 20%, rgba(196, 31, 43, 0.14) 0%, transparent 70%)', borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
        <div style={{ maxWidth: '1140px', margin: '0 auto', padding: '0 1.5rem', textAlign: 'center' }}>
          <button
            type="button"
            onClick={() => navigate('/')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              background: 'none',
              border: 'none',
              color: 'var(--admin-brand, #C41F2B)',
              fontSize: '0.8rem',
              fontWeight: '800',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              cursor: 'pointer',
              marginBottom: '1rem'
            }}
          >
            <ArrowLeft size={16} />
            <span>Back to Home</span>
          </button>

          <h1 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.75rem)', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 1rem' }}>
            Services & Detailing Packages
          </h1>
          <p style={{ maxWidth: '640px', margin: '0 auto 2rem', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>
            Comprehensive automotive detailing, paint protection, ceramic coatings, and interior restoration tailored to your vehicle type.
          </p>

          {/* Search Box */}
          <div style={{ maxWidth: '520px', margin: '0 auto', position: 'relative' }}>
            <Search size={18} style={{ position: 'absolute', left: '1.1rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.45 }} />
            <input
              type="text"
              placeholder="Search service by name or vehicle type..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="services-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                style={{ position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', opacity: 0.5, cursor: 'pointer', color: 'inherit' }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── CATEGORY PILL FILTER BAR ── */}
      <div style={{ position: 'sticky', top: '70px', zIndex: 900, background: 'var(--admin-card, rgba(14, 16, 19, 0.95))', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', padding: '0.85rem 1.5rem' }}>
        <div style={{ maxWidth: '1140px', margin: '0 auto', display: 'flex', gap: '0.65rem', overflowX: 'auto', paddingBottom: '0.2rem', scrollbarWidth: 'none' }}>
          {categories.map((cat) => {
            const count = cat === 'ALL'
              ? Object.values(catalog).reduce((acc, l) => acc + l.length, 0)
              : (catalog[cat]?.length || 0);

            return (
              <button
                key={cat}
                type="button"
                className={`services-pill ${activeCategory === cat ? 'is-active' : ''}`}
                onClick={() => setActiveCategory(cat)}
              >
                {cat} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* ── MAIN CATALOG GRID ── */}
      <main style={{ flex: 1, maxWidth: '1140px', margin: '0 auto', width: '100%', padding: '2.5rem 1.5rem 4rem' }}>
        {totalFilteredServices === 0 ? (
          <div style={{ textAlign: 'center', padding: '5rem 1.5rem' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(255, 255, 255, 0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem', opacity: 0.5 }}>
              <Search size={28} />
            </div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '900', margin: '0 0 0.5rem' }}>No Services Match Your Search</h3>
            <p style={{ opacity: 0.6, fontSize: '0.9rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
              Try adjusting your search terms or select another category filter.
            </p>
            <button
              type="button"
              className="services-pill is-active"
              onClick={() => { setSearchQuery(''); setActiveCategory('ALL'); }}
            >
              Reset Filters
            </button>
          </div>
        ) : (
          Object.entries(filteredCategories).map(([category, services]) => (
            <section key={category} style={{ marginBottom: '4rem' }}>
              {/* Category Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.75rem' }}>
                <h2 style={{ fontSize: '1.35rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '0.5px', margin: 0 }}>
                  {category}
                </h2>
                <span style={{ fontSize: '0.75rem', fontWeight: '800', opacity: 0.5, textTransform: 'uppercase' }}>
                  ({services.length} {services.length === 1 ? 'service' : 'services'})
                </span>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }} />
              </div>

              {/* Grid of Service Cards with Photo Placeholders */}
              <div className="category-services-grid">
                {services.map((service, idx) => (
                  <div key={service.id || idx} style={{ display: 'flex', flexDirection: 'column' }}>
                    <ServiceCard service={service} formatPrice={formatPrice} />
                  </div>
                ))}
              </div>
            </section>
          ))
        )}

        {/* ── CALL TO ACTION BANNER ── */}
        <div style={{
          marginTop: '3rem',
          padding: 'clamp(2rem, 4vw, 3.5rem)',
          borderRadius: '16px',
          background: 'radial-gradient(ellipse at 50% 50%, rgba(196, 31, 43, 0.18) 0%, rgba(14, 16, 19, 0.95) 100%)',
          border: '1px solid rgba(196, 31, 43, 0.3)',
          textAlign: 'center',
          boxShadow: '0 12px 35px rgba(0, 0, 0, 0.4)'
        }}>
          <h3 style={{ fontSize: 'clamp(1.25rem, 2.5vw, 1.85rem)', fontWeight: '950', textTransform: 'uppercase', margin: '0 0 0.75rem' }}>
            Ready to Transform Your Vehicle?
          </h3>
          <p style={{ maxWidth: '580px', margin: '0 auto 1.75rem', opacity: 0.75, fontSize: '0.95rem', lineHeight: '1.6' }}>
            Book online in less than 2 minutes. Choose your vehicle, select your preferred services, and lock in your scheduled detailing slot.
          </p>
          <button
            type="button"
            onClick={() => navigate(user ? '/customer/book' : '/login')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.65rem',
              padding: '0.95rem 2.25rem',
              fontSize: '0.9rem',
              fontWeight: '900',
              textTransform: 'uppercase',
              letterSpacing: '1px',
              background: 'var(--admin-brand, #C41F2B)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              boxShadow: '0 6px 20px rgba(196, 31, 43, 0.4)',
              transition: 'transform 0.2s ease'
            }}
          >
            <Calendar size={18} />
            <span>Book An Appointment</span>
            <ChevronRight size={18} />
          </button>
        </div>
      </main>

      {/* ── FOOTER ── */}
      <SiteFooter
        businessName={businessName}
        links={FOOTER_LINKS}
        onNavigate={(id) => {
          const item = FOOTER_LINKS.find(l => l.id === id);
          if (item?.action) item.action();
        }}
        socials={SOCIALS}
      />
    </div>
  );
}

