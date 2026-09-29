import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  MapPin,
  Phone,
  Mail,
  Clock,
  Shield,
  Zap,
  Star,
  Facebook,
  Instagram,
  Twitter,
  X as XIcon,
  LogIn,
  LayoutDashboard,
  LogOut,
  ChevronDown
} from 'lucide-react';
import Login from './Login';
import { useAuth } from '../hooks/useAuth';
import { useConfig } from '../context/ConfigContext';
import { getServiceCatalog } from '../data/servicesCatalog';

// ─── Smooth Scroll-Reveal Component ──────────────────────────────────────────
// Slightly slower / gentler transitions vs the previous version (0.85 s, ease-out cubic).
function Reveal({ children, delay = 0, direction = 'up', style: extraStyle = {}, className = '' }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) { setVisible(true); obs.disconnect(); }
      },
      { threshold: 0.1, rootMargin: '0px 0px -30px 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const translateMap = {
    up:    'translateY(24px)',
    down:  'translateY(-24px)',
    left:  'translateX(24px)',
    right: 'translateX(-24px)',
  };

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translate(0,0) scale(1)' : `${translateMap[direction] || 'translateY(24px)'} scale(0.99)`,
        // Slower, gentler: 0.85 s vs previous 0.65 s, cubic-bezier emphasises ease-out
        transition: `opacity 0.85s cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms, transform 0.85s cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms`,
        willChange: 'opacity, transform',
        ...extraStyle,
      }}
    >
      {children}
    </div>
  );
}

// ─── Landing ──────────────────────────────────────────────────────────────────
const Landing = () => {
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState(null);
  const [openService, setOpenService] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  // Track which service categories are collapsed on mobile (all collapsed by default)
  const [collapsedCategories, setCollapsedCategories] = useState({});
  const { user, profile, signOut, isInitialized, loading: authLoading } = useAuth();
  const { settings } = useConfig();
  const navigate = useNavigate();

  const businessName = settings?.BUSINESS_NAME || 'COMAR GARAGE';

  const [catalog, setCatalog] = useState(() => getServiceCatalog());
  useEffect(() => {
    const refreshCatalog = () => setCatalog(getServiceCatalog());
    refreshCatalog();
    window.addEventListener('storage', refreshCatalog);
    return () => window.removeEventListener('storage', refreshCatalog);
  }, [settings?.BUSINESS_NAME]);

  // Initialise all categories as collapsed on mobile
  useEffect(() => {
    const initial = {};
    Object.keys(catalog).forEach(cat => { initial[cat] = true; });
    setCollapsedCategories(initial);
  }, [catalog]);

  const toggleCategory = (cat) => {
    setCollapsedCategories(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  const faqItems = (Array.isArray(settings?.FAQS) ? settings.FAQS : [])
    .filter((f) => f && String(f.question || '').trim())
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .map((f) => ({ question: String(f.question).trim(), answer: String(f.answer || '').trim() }));

  const displayFaqs = faqItems.length > 0 ? faqItems : [
    { question: 'How long does ceramic coating last?', answer: 'Our premium ceramic coatings typically last between 2 to 5 years depending on package selection and vehicle maintenance habits.' },
    { question: 'What is the booking process?', answer: 'Simply select your vehicle type, choose desired services, pick your preferred date and time slot, and confirm your reservation.' },
    { question: 'Do you offer mobile services?', answer: 'We currently operate primarily at our fully equipped detailing bay in Cainta to ensure clean room standards and climate-controlled curing.' },
    { question: 'What payment methods do you accept?', answer: 'We accept Cash, GCash, Bank Transfer, and major Credit Cards with instant verification and official receipts.' },
    { question: 'Do I need to leave my car overnight?', answer: 'For multi-stage paint correction and ceramic curing, overnight stays in our secured, monitored facility may be required.' }
  ];

  const formatPrice = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num.toLocaleString() : String(value ?? '');
  };

  const contactItems = [
    { icon: MapPin, label: 'Address', val: settings?.BUSINESS_ADDRESS || '39 Hunters ROTC, Barangay San Juan, Cainta, 1900 Rizal' },
    { icon: Phone,  label: 'Phone',   val: settings?.BUSINESS_CONTACT_NUMBER || 'Not provided' },
    { icon: Mail,   label: 'Email',   val: settings?.BUSINESS_EMAIL || 'Not provided' }
  ];

  const handleAuthAction = () => {
    if (!isInitialized || authLoading) return;
    if (user) {
      if (profile) {
        const roleKey = String(profile.role || '').toUpperCase();
        const routes = { ADMIN: '/admin', STAFF: '/staff', CUSTOMER: '/customer' };
        navigate(routes[roleKey] || '/customer');
      } else {
        navigate('/customer');
      }
    } else {
      setShowLoginModal(true);
    }
    setMenuOpen(false);
  };

  useEffect(() => {
    document.documentElement.classList.add('landing-scroll');
    document.body.classList.add('landing-scroll');
    document.getElementById('root')?.classList.add('landing-scroll');
    const handleScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      document.documentElement.classList.remove('landing-scroll');
      document.body.classList.remove('landing-scroll');
      document.getElementById('root')?.classList.remove('landing-scroll');
    };
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  useEffect(() => {
    if (isInitialized && !authLoading && user?.id && profile?.role) {
      const roleKey = String(profile.role || '').toUpperCase();
      const routes = { ADMIN: '/admin', STAFF: '/staff', CUSTOMER: '/customer' };
      const targetRoute = routes[roleKey] || '/customer';
      if (window.location.pathname !== targetRoute) navigate(targetRoute, { replace: true });
    }
  }, [isInitialized, authLoading, user, profile, navigate]);

  const scrollToSection = useCallback((id) => {
    setMenuOpen(false);
    setTimeout(() => {
      const element = document.getElementById(id);
      if (element) element.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (!e.target.closest('.menu-drawer') && !e.target.closest('.three-lines-btn')) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const NAV_LINKS = [
    { label: 'Home',     id: 'home' },
    { label: 'About',    id: 'about' },
    { label: 'Services', id: 'services' },
    { label: 'FAQ',      id: 'faq' },
    { label: 'Contact',  id: 'contact' },
  ];

  return (
    <div style={{ background: '#0A0B0D', color: 'white', minHeight: '100vh', position: 'relative', overflowX: 'hidden' }}>

      {/* ── GLOBAL CSS ── */}
      <style>{`
        html { scroll-behavior: smooth; }
        .section-padding { padding: clamp(4rem, 10vw, 8rem) clamp(1rem, 5vw, 4rem); }
        .container-wide  { max-width: 1200px; margin: 0 auto; width: 100%; }

        /* Card hover */
        .lp-card-hover {
          transition: transform 0.28s ease, border-color 0.28s ease, box-shadow 0.28s ease;
        }
        .lp-card-hover:hover {
          transform: translateY(-4px);
          border-color: rgba(230, 30, 42, 0.4) !important;
          box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
        }

        /* Three-lines hamburger button */
        .three-lines-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.06);
          border: 1.5px solid rgba(255, 255, 255, 0.2);
          border-radius: 12px;
          width: 46px;
          height: 46px;
          cursor: pointer;
          color: white;
          padding: 8px;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          flex-shrink: 0;
        }
        .three-lines-btn:hover {
          background: rgba(255, 255, 255, 0.12);
          border-color: rgba(255, 255, 255, 0.38);
          transform: scale(1.05);
        }
        .three-lines-btn:active { transform: scale(0.95); }

        /* Menu drawer link items */
        .menu-link-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 0.95rem 1rem;
          background: transparent;
          border: none;
          border-radius: 8px;
          color: rgba(255, 255, 255, 0.85);
          font-size: 0.95rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 1.2px;
          cursor: pointer;
          transition: all 0.2s ease;
          text-align: left;
        }
        .menu-link-item:hover {
          background: rgba(230, 30, 42, 0.12);
          color: #fff;
          transform: translateX(6px);
        }

        /* Backdrop */
        .menu-drawer-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.65);
          backdrop-filter: blur(8px);
          z-index: 1050;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s ease;
        }
        .menu-drawer-backdrop.is-open {
          opacity: 1;
          pointer-events: auto;
        }

        /* Drawer */
        .menu-drawer {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          width: min(340px, 86vw);
          background: #0E1013;
          border-left: 1px solid rgba(255, 255, 255, 0.1);
          z-index: 1060;
          transform: translateX(100%);
          transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);
          display: flex;
          flex-direction: column;
          box-shadow: -10px 0 35px rgba(0, 0, 0, 0.6);
          padding: 1.5rem;
          box-sizing: border-box;
        }
        .menu-drawer.is-open { transform: translateX(0); }

        /* Hero video */
        .hero-video {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          /* Desktop: show the centre-right which has the gradient/car */
          object-position: center center;
          z-index: 0;
          opacity: 0.55;
        }
        @media (max-width: 768px) {
          .hero-video {
            /* Mobile: force to centre so the red gradient radiance is visible */
            object-position: center center;
            opacity: 0.45;
          }
          .hero-content h1 { font-size: clamp(2rem, 8vw, 3rem) !important; }

          /* Mobile services collapse toggle */
          .cat-toggle-btn { display: flex !important; }
          .cat-services-grid {
            overflow: hidden;
            transition: max-height 0.45s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease;
          }
          .cat-services-grid.collapsed {
            max-height: 0 !important;
            opacity: 0;
            pointer-events: none;
          }
          .cat-services-grid.expanded {
            max-height: 9999px;
            opacity: 1;
          }
        }

        /* Desktop: always show services, hide toggle */
        @media (min-width: 769px) {
          .cat-toggle-btn { display: none !important; }
          .cat-services-grid { max-height: none !important; opacity: 1 !important; }
        }

        /* Fluid text */
        .text-fluid-h1 { font-size: clamp(2.8rem, 7vw, 5.5rem); }
        .text-fluid-h2 { font-size: clamp(1.8rem, 4vw, 3rem); }
        .text-fluid-body { font-size: clamp(0.9rem, 1.5vw, 1.1rem); }
      `}</style>

      {/* ── 1. STICKY HEADER ── */}
      <header
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: scrolled ? '64px' : '72px',
          background: scrolled ? 'rgba(10, 11, 13, 0.96)' : 'rgba(10, 11, 13, 0.45)',
          backdropFilter: 'blur(18px)',
          borderBottom: scrolled ? '1px solid rgba(255,255,255,0.08)' : '1px solid transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 clamp(1.2rem, 5vw, 3.5rem)',
          zIndex: 1000,
          transition: 'all 0.35s cubic-bezier(0.22, 1, 0.36, 1)'
        }}
      >
        {/* LOGO */}
        <div
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          style={{ cursor: 'pointer' }}
        >
          <div style={{ color: 'white', fontSize: 'clamp(1.1rem, 3vw, 1.7rem)', fontWeight: 950, letterSpacing: '0.08em', fontStyle: 'italic', textTransform: 'uppercase' }}>
            {businessName}
          </div>
        </div>

        {/* THREE-LINES BUTTON */}
        <button
          className="three-lines-btn"
          onClick={() => setMenuOpen(o => !o)}
          aria-label="Navigation Menu"
        >
          {menuOpen ? (
            <XIcon size={22} />
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="18" x2="20" y2="18" />
            </svg>
          )}
        </button>
      </header>

      {/* ── 2. MENU DRAWER ── */}
      <div
        className={`menu-drawer-backdrop ${menuOpen ? 'is-open' : ''}`}
        onClick={() => setMenuOpen(false)}
      />

      <aside className={`menu-drawer ${menuOpen ? 'is-open' : ''}`}>
        {/* Drawer header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem', paddingBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1.5px', color: 'rgba(255,255,255,0.5)' }}>
            Navigation
          </span>
          <button
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
            style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', padding: '4px', display: 'flex' }}
          >
            <XIcon size={20} />
          </button>
        </div>

        {/* Nav links */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
          {NAV_LINKS.map(link => (
            <button
              key={link.id}
              onClick={() => scrollToSection(link.id)}
              className="menu-link-item"
            >
              <span>{link.label}</span>
              <ChevronRight size={16} opacity={0.4} />
            </button>
          ))}
        </nav>

        {/* Footer actions */}
        <div style={{ marginTop: 'auto', paddingTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <button
            onClick={handleAuthAction}
            style={{
              width: '100%',
              padding: '0.9rem 1.25rem',
              background: '#E61E2A',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontWeight: '950',
              fontSize: '0.85rem',
              textTransform: 'uppercase',
              letterSpacing: '1.2px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.6rem',
              boxShadow: '0 6px 18px rgba(230, 30, 42, 0.35)',
              transition: 'transform 0.15s ease'
            }}
            onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.02)'}
            onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
          >
            {user ? <LayoutDashboard size={18} /> : <LogIn size={18} />}
            <span>{!isInitialized || authLoading ? 'SYNCING...' : (user ? 'DASHBOARD' : 'LOGIN')}</span>
          </button>

          {user && (
            <button
              onClick={() => { signOut(); setMenuOpen(false); }}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                background: 'transparent',
                color: 'rgba(255,255,255,0.7)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '8px',
                fontWeight: '800',
                fontSize: '0.78rem',
                textTransform: 'uppercase',
                letterSpacing: '1px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                transition: 'all 0.15s ease'
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#ef4444'; e.currentTarget.style.color = '#ef4444'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >
              <LogOut size={16} />
              <span>SIGN OUT</span>
            </button>
          )}
        </div>
      </aside>

      {/* ── 3. HERO SECTION ── */}
      <section
        id="home"
        style={{
          height: '100vh',
          width: '100%',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden'
        }}
      >
        {/* Background video — object-position: center keeps the red glow centered on mobile */}
        <video
          className="hero-video"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
        >
          <source src="/hero-bg.mp4" type="video/mp4" />
        </video>

        {/* Gradient overlay so text stays readable */}
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to bottom, rgba(10,11,13,0.55) 0%, rgba(10,11,13,0.35) 50%, rgba(10,11,13,0.75) 100%)',
          zIndex: 1
        }} />

        <div className="hero-content" style={{ position: 'relative', zIndex: 2, textAlign: 'center', maxWidth: '900px', padding: '0 2rem' }}>
          <Reveal delay={120} direction="up">
            <h1 className="text-fluid-h1" style={{ fontWeight: '950', lineHeight: '0.92', textTransform: 'uppercase', marginBottom: '1.5rem', letterSpacing: '-2px' }}>
              TURN THE COLOR <br />
              <span style={{ color: '#E61E2A' }}>TO THE MAXIMUM</span>
            </h1>
          </Reveal>

          <Reveal delay={280} direction="up">
            <p className="text-fluid-body" style={{ color: 'rgba(255,255,255,0.75)', maxWidth: '600px', margin: '0 auto 2.5rem', lineHeight: '1.65', fontWeight: '600' }}>
              Experience premium automotive detailing services that bring out the true brilliance of your vehicle. Our expert team uses cutting-edge techniques to deliver stunning results.
            </p>
          </Reveal>

          <Reveal delay={440} direction="up">
            <button
              onClick={handleAuthAction}
              style={{
                padding: '1.25rem 3.5rem',
                background: '#E61E2A',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontWeight: '950',
                fontSize: '0.9rem',
                textTransform: 'uppercase',
                letterSpacing: '2px',
                cursor: 'pointer',
                boxShadow: '0 10px 30px rgba(230, 30, 42, 0.38)',
                transition: 'transform 0.2s ease, box-shadow 0.2s ease'
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 14px 34px rgba(230, 30, 42, 0.52)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 10px 30px rgba(230, 30, 42, 0.38)'; }}
            >
              {!isInitialized || authLoading ? 'SYNCING...' : (user ? 'DASHBOARD' : 'BOOK NOW')}
            </button>
          </Reveal>
        </div>
      </section>

      {/* ── 4. ABOUT SECTION ── */}
      <section id="about" className="section-padding" style={{ background: '#0A0B0D' }}>
        <div className="container-wide" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 'clamp(2rem, 5vw, 4.5rem)', alignItems: 'center' }}>
          <Reveal direction="right">
            <h2 className="text-fluid-h2" style={{ textTransform: 'uppercase', marginBottom: '1.75rem', fontWeight: 950 }}>ABOUT US</h2>
            <p style={{ fontSize: '1.1rem', color: 'rgba(255,255,255,0.65)', lineHeight: '1.8', marginBottom: '1.5rem' }}>
              At Comar Garage, we believe that every vehicle deserves to look its absolute best.
              Founded with a passion for automotive excellence, we have grown into one of the region's
              most trusted detailing centers.
            </p>
          </Reveal>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
            {[
              { icon: Shield, title: 'PROTECTION',  desc: 'Premium ceramic coatings', delay: 50 },
              { icon: Zap,    title: 'PERFORMANCE', desc: 'Expert technicians',       delay: 150 },
              { icon: Star,   title: 'QUALITY',     desc: 'Satisfaction guaranteed',  delay: 250 },
              { icon: Clock,  title: 'RELIABILITY', desc: 'Punctual service',         delay: 350 },
            ].map((item) => (
              <Reveal key={item.title} delay={item.delay} direction="up">
                <div
                  className="lp-card-hover"
                  style={{
                    background: '#15171A',
                    padding: '2rem 1.5rem',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.06)'
                  }}
                >
                  <item.icon style={{ color: '#E61E2A', marginBottom: '1rem' }} size={32} />
                  <h4 style={{ fontSize: '0.9rem', fontWeight: '950', marginBottom: '0.5rem', textTransform: 'uppercase' }}>{item.title}</h4>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', margin: 0 }}>{item.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 5. SERVICES SECTION ── */}
      <section id="services" className="section-padding" style={{ background: '#0F1012' }}>
        <div className="container-wide">
          <Reveal direction="up">
            <div style={{ textAlign: 'center', marginBottom: '4.5rem' }}>
              <h2 className="text-fluid-h2" style={{ textTransform: 'uppercase', marginBottom: '1rem', fontWeight: 950 }}>OUR SERVICES</h2>
              <div style={{ width: '80px', height: '4px', background: '#E61E2A', margin: '0 auto', borderRadius: '2px' }} />
            </div>
          </Reveal>

          {Object.entries(catalog).map(([category, services], catIndex) => {
            const isCatCollapsed = collapsedCategories[category] !== false; // default collapsed

            return (
              <div key={category} style={{ marginBottom: '5rem' }}>
                {/* Category header row — on mobile shows a tap-to-expand button */}
                <Reveal direction="left">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'clamp(0.75rem, 2vw, 2rem)',
                      marginBottom: '2.5rem',
                      minWidth: 0,
                      cursor: 'pointer'
                    }}
                    onClick={() => toggleCategory(category)}
                  >
                    <h3 style={{ fontSize: 'clamp(1.05rem, 3.5vw, 1.45rem)', fontWeight: '950', textTransform: 'uppercase', color: 'rgba(255,255,255,0.92)', minWidth: 0, margin: 0 }}>
                      {category}
                    </h3>
                    <div style={{ flex: 1, minWidth: '1rem', height: '1px', background: 'rgba(255,255,255,0.1)' }} />
                    {/* Mobile-only collapse toggle */}
                    <button
                      className="cat-toggle-btn"
                      type="button"
                      aria-label={isCatCollapsed ? 'Expand' : 'Collapse'}
                      style={{
                        display: 'none', // shown via CSS on mobile
                        background: 'rgba(230,30,42,0.1)',
                        border: '1px solid rgba(230,30,42,0.25)',
                        borderRadius: '6px',
                        color: '#E61E2A',
                        padding: '0.35rem 0.65rem',
                        cursor: 'pointer',
                        fontSize: '0.7rem',
                        fontWeight: '950',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        alignItems: 'center',
                        gap: '0.3rem',
                        flexShrink: 0,
                        transition: 'all 0.2s'
                      }}
                    >
                      <ChevronDown
                        size={14}
                        style={{
                          transform: isCatCollapsed ? 'rotate(0deg)' : 'rotate(180deg)',
                          transition: 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)'
                        }}
                      />
                      {isCatCollapsed ? `${services.length} services` : 'Collapse'}
                    </button>
                  </div>
                </Reveal>

                {/* Services grid — collapsed on mobile by default */}
                <div
                  className={`cat-services-grid ${isCatCollapsed ? 'collapsed' : 'expanded'}`}
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: '1.5rem' }}
                >
                  {services.map((service, i) => {
                    const serviceKey = `${catIndex}-${i}`;
                    return (
                      <Reveal key={i} delay={Math.min(i * 60, 280)} direction="up">
                        <div
                          className="lp-card-hover"
                          onClick={() => setOpenService(openService === serviceKey ? null : serviceKey)}
                          style={{
                            background: '#15171A',
                            padding: '2rem',
                            borderRadius: '8px',
                            border: '1px solid rgba(255,255,255,0.06)',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column'
                          }}
                        >
                          <div style={{ width: '40px', height: '40px', background: 'rgba(230, 30, 42, 0.12)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.5rem' }}>
                            <ChevronRight
                              style={{
                                color: '#E61E2A',
                                transform: openService === serviceKey ? 'rotate(90deg)' : 'rotate(0deg)',
                                transition: 'transform 0.3s ease'
                              }}
                              size={20}
                            />
                          </div>

                          <h4 style={{ fontSize: '1.1rem', fontWeight: '950', marginBottom: '0.75rem', textTransform: 'uppercase' }}>
                            {service.name}
                          </h4>

                          <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.5)', lineHeight: '1.6', margin: 0 }}>
                            {service.desc}
                          </p>

                          <div
                            style={{
                              maxHeight: openService === serviceKey ? '400px' : '0',
                              overflow: 'hidden',
                              transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                              opacity: openService === serviceKey ? 1 : 0,
                              marginTop: openService === serviceKey ? '1.5rem' : '0'
                            }}
                          >
                            <div
                              style={{
                                padding: '1rem',
                                background: 'rgba(230, 30, 42, 0.05)',
                                border: '1px dashed rgba(230, 30, 42, 0.25)',
                                borderRadius: '6px',
                              }}
                            >
                              <span style={{ fontSize: '0.7rem', fontWeight: '950', color: '#E61E2A', display: 'block', marginBottom: '10px', letterSpacing: '1px', textAlign: 'center', textTransform: 'uppercase' }}>
                                Vehicle Pricing
                              </span>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {Object.entries(service.prices).map(([type, price]) => (
                                  <div key={type} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                    <span style={{ fontSize: '0.75rem', fontWeight: '700', color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase' }}>{type}</span>
                                    <span style={{ fontSize: '0.9rem', fontWeight: '950', color: 'white' }}>₱{formatPrice(price)}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      </Reveal>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── 6. FAQ SECTION ── */}
      <section id="faq" className="section-padding" style={{ background: '#0A0B0D' }}>
        <div style={{ maxWidth: '820px', margin: '0 auto', padding: '0 1rem' }}>
          <Reveal direction="up">
            <h2 className="text-fluid-h2" style={{ textTransform: 'uppercase', marginBottom: '3.5rem', textAlign: 'center', fontWeight: 950 }}>
              FAQ
            </h2>
          </Reveal>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {displayFaqs.map((faq, i) => (
              <Reveal key={i} delay={i * 55} direction="up">
                <div
                  className="lp-card-hover"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  style={{
                    background: '#15171A',
                    padding: '1.5rem 2rem',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.06)',
                    cursor: 'pointer',
                    transition: 'all 0.25s ease'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                    <span style={{ fontWeight: '800', fontSize: '0.92rem' }}>{faq.question}</span>
                    <ChevronRight
                      size={20}
                      style={{
                        color: 'rgba(255,255,255,0.3)',
                        transform: openFaq === i ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.3s ease',
                        flexShrink: 0
                      }}
                    />
                  </div>

                  {faq.answer && (
                    <div
                      style={{
                        maxHeight: openFaq === i ? '400px' : '0',
                        overflow: 'hidden',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        opacity: openFaq === i ? 1 : 0,
                        marginTop: openFaq === i ? '1rem' : '0'
                      }}
                    >
                      <p
                        style={{
                          fontSize: '0.85rem',
                          color: 'rgba(255,255,255,0.55)',
                          lineHeight: '1.65',
                          paddingTop: '0.75rem',
                          borderTop: '1px solid rgba(255,255,255,0.06)',
                          margin: 0
                        }}
                      >
                        {faq.answer}
                      </p>
                    </div>
                  )}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 7. CONTACT SECTION ── */}
      <section id="contact" className="section-padding" style={{ background: '#0F1012' }}>
        <div className="container-wide" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 'clamp(2rem, 5vw, 5.5rem)' }}>
          <Reveal direction="right">
            <h2 className="text-fluid-h2" style={{ textTransform: 'uppercase', marginBottom: '1.5rem', fontWeight: 950 }}>
              CONTACT US
            </h2>
            <p style={{ color: 'rgba(255,255,255,0.55)', marginBottom: '2.5rem', lineHeight: '1.8' }}>
              Ready to give your car the Comar Garage treatment? Get in touch with us for quotes, appointments, or any inquiries.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {contactItems.map((item, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    gap: '1.25rem',
                    alignItems: 'center',
                    padding: '1.1rem 1.25rem',
                    background: '#15171A',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.06)'
                  }}
                >
                  <div style={{ width: '46px', height: '46px', background: '#0A0B0D', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
                    <item.icon size={20} style={{ color: '#E61E2A' }} />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.68rem', fontWeight: '950', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                      {item.label}
                    </div>
                    <div style={{ fontSize: '0.88rem', fontWeight: '800', marginTop: '0.15rem' }}>
                      {item.val}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal direction="left" delay={150}>
            <div style={{ background: '#15171A', padding: 'clamp(1.5rem, 5vw, 3rem)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
              <form style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }} onSubmit={(e) => e.preventDefault()}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.25rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.7rem', fontWeight: '950', textTransform: 'uppercase', opacity: 0.5, letterSpacing: '0.5px' }}>Name</label>
                    <input type="text" style={{ background: '#0A0B0D', border: '1px solid rgba(255,255,255,0.1)', padding: '0.9rem 1rem', borderRadius: '6px', color: 'white', fontWeight: '700', outline: 'none' }} placeholder="John Doe" />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.7rem', fontWeight: '950', textTransform: 'uppercase', opacity: 0.5, letterSpacing: '0.5px' }}>Email</label>
                    <input type="email" style={{ background: '#0A0B0D', border: '1px solid rgba(255,255,255,0.1)', padding: '0.9rem 1rem', borderRadius: '6px', color: 'white', fontWeight: '700', outline: 'none' }} placeholder="john@example.com" />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <label style={{ fontSize: '0.7rem', fontWeight: '950', textTransform: 'uppercase', opacity: 0.5, letterSpacing: '0.5px' }}>Message</label>
                  <textarea rows="5" style={{ background: '#0A0B0D', border: '1px solid rgba(255,255,255,0.1)', padding: '1rem', borderRadius: '6px', color: 'white', fontWeight: '700', resize: 'none', outline: 'none' }} placeholder="Tell us about your project..." />
                </div>
                <button
                  type="submit"
                  style={{
                    padding: '1.15rem',
                    background: '#E61E2A',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    fontWeight: '950',
                    fontSize: '0.9rem',
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    cursor: 'pointer',
                    boxShadow: '0 8px 24px rgba(230, 30, 42, 0.3)',
                    transition: 'transform 0.15s ease'
                  }}
                  onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                  onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
                >
                  SEND MESSAGE
                </button>
              </form>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── 8. FOOTER ── */}
      <footer style={{ padding: '3.5rem 2rem', background: '#0A0B0D', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '2rem' }}>
          <div>
            <div style={{ fontWeight: '950', fontSize: '1.2rem', letterSpacing: '-0.5px', fontStyle: 'italic', color: '#E61E2A', textTransform: 'uppercase' }}>
              {businessName}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', marginTop: '0.4rem' }}>
              © 2024 COMAR GARAGE. ALL RIGHTS RESERVED.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '1.5rem' }}>
            <Facebook size={18} style={{ color: 'rgba(255,255,255,0.4)', cursor: 'pointer', transition: 'color 0.2s' }} onMouseEnter={e => e.currentTarget.style.color = '#fff'} onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'} />
            <Instagram size={18} style={{ color: 'rgba(255,255,255,0.4)', cursor: 'pointer', transition: 'color 0.2s' }} onMouseEnter={e => e.currentTarget.style.color = '#fff'} onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'} />
            <Twitter size={18} style={{ color: 'rgba(255,255,255,0.4)', cursor: 'pointer', transition: 'color 0.2s' }} onMouseEnter={e => e.currentTarget.style.color = '#fff'} onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'} />
          </div>
        </div>
      </footer>

      {/* LOGIN MODAL */}
      {showLoginModal && <Login isModal onClose={() => setShowLoginModal(false)} />}
    </div>
  );
};

export default Landing;
