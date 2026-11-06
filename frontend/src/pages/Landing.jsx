import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  MapPin,
  Phone,
  Mail,
  Facebook,
  Instagram,
  Twitter,
  X as XIcon,
  LogIn,
  LogOut,
  ChevronDown
} from 'lucide-react';
import Login from './Login';
import { useAuth } from '../hooks/useAuth';
import { useConfig } from '../context/ConfigContext';
import { getServiceCatalog } from '../data/servicesCatalog';
import AboutGallery from '../features/site-content/AboutGallery';
import ShopMap from '../features/site-content/ShopMap';
import { aboutIcon, resolveAbout } from '../features/site-content/aboutContent';
import { AuthButtons, MobileMenu, ServiceCard, FaqList, ContactCards, ContactForm, HeroActions, AboutFeatures, SiteFooter } from '../features/landing/LandingParts';

// ─── Smooth Cinematic Scroll-Reveal Component ────────────────────────────────
// Slow, luxurious transition (1.4s, cubic-bezier ease-out + soft focal blur)
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
      { threshold: 0.08, rootMargin: '0px 0px -25px 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const translateMap = {
    up:    'translateY(28px)',
    down:  'translateY(-28px)',
    left:  'translateX(28px)',
    right: 'translateX(-28px)',
  };

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translate(0,0) scale(1)' : `${translateMap[direction] || 'translateY(28px)'} scale(0.985)`,
        filter: visible ? 'blur(0px)' : 'blur(4px)',
        transition: `opacity 1.4s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform 1.4s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, filter 1.4s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
        willChange: 'opacity, transform, filter',
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
  // Where the sign-in pop-up sends someone afterwards: the booking form for "Book" buttons, otherwise their dashboard.
  const [loginNext, setLoginNext] = useState(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState(null);
  const [openService, setOpenService] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  // Track which service categories are collapsed on mobile (all collapsed by default)
  const [collapsedCategories, setCollapsedCategories] = useState({});
  const { user, profile, signOut, isInitialized, loading: authLoading } = useAuth();
  const { settings } = useConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const authActionPending = Boolean(user && (!isInitialized || authLoading));

  const businessName = settings?.BUSINESS_NAME || 'COMAR GARAGE';
  const aboutPhotos = Array.isArray(settings?.ABOUT_PHOTOS) ? settings.ABOUT_PHOTOS : [];
  const shopLocation = settings?.SHOP_LOCATION || null;
  // Business Hub › About & Map: banner photo, About heading, paragraph and highlights
  const heroPhoto = settings?.HERO_PHOTO || null;
  const about = resolveAbout(settings);
  const aboutCards = about.cards.map((c) => ({ icon: aboutIcon(c.icon), title: c.title, desc: c.text }));

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
    if (!user) {
      setLoginNext(undefined);
      setShowLoginModal(true);
      setMenuOpen(false);
      return;
    }

    if (authActionPending) return;

    if (profile) {
      const roleKey = String(profile.role || '').toUpperCase();
      const routes = { ADMIN: '/admin', STAFF: '/staff', CUSTOMER: '/customer' };
      navigate(routes[roleKey] || '/customer');
    } else {
      navigate('/customer');
    }
    setMenuOpen(false);
  };

  // "Book" buttons: signed-out visitors get the sign-in pop-up and continue to the booking form afterwards.
  const handleBookAction = () => {
    if (!user) {
      setLoginNext('/customer/book');
      setShowLoginModal(true);
      setMenuOpen(false);
      return;
    }
    handleAuthAction();
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
    // While the sign-in pop-up is open it decides where to go (e.g. the booking form after "Book now").
    if (showLoginModal) return;
    if (isInitialized && !authLoading && user?.id && profile?.role) {
      const roleKey = String(profile.role || '').toUpperCase();
      const routes = { ADMIN: '/admin', STAFF: '/staff', CUSTOMER: '/customer' };
      const targetRoute = routes[roleKey] || '/customer';
      if (window.location.pathname !== targetRoute) navigate(targetRoute, { replace: true });
    }
  }, [isInitialized, authLoading, user, profile, navigate, showLoginModal]);

  const scrollToSection = useCallback((id) => {
    setMenuOpen(false);
    if (id === 'services') {
      navigate('/services');
      return;
    }
    setTimeout(() => {
      const element = document.getElementById(id);
      if (element) element.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, [navigate]);

  // Arriving from another page (e.g. /services → About): scroll to the requested section, then clear the request
  // so a reload or the back button does not jump again.
  useEffect(() => {
    const target = location.state?.scrollTo;
    if (!target) return undefined;
    const timer = setTimeout(() => {
      document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' });
      navigate(location.pathname, { replace: true, state: null });
    }, 350);
    return () => clearTimeout(timer);
  }, [location.state, location.pathname, navigate]);

  const featuredServices = useMemo(() => {
    const list = [
      catalog['Car Wash']?.[1] || catalog['Car Wash']?.[0],
      catalog['Packages']?.[1] || catalog['Packages']?.[0],
      catalog['Detailing']?.[2] || catalog['Detailing']?.[0],
    ].filter(Boolean);
    return list.length > 0 ? list : (catalog['Car Wash'] || []).slice(0, 3);
  }, [catalog]);

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
        .section-padding { padding: clamp(3rem, 5.5vw, 5.5rem) clamp(1rem, 5vw, 3.5rem); }
        .container-wide  { max-width: 1140px; margin: 0 auto; width: 100%; }

        /* Card hover - slow, gentle response */
        .lp-card-hover {
          transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.4s ease, box-shadow 0.4s ease;
        }
        .lp-card-hover:hover {
          transform: translateY(-4px);
          border-color: rgba(196, 31, 43, 0.4) !important;
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
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
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
          font-size: 0.9rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 1.2px;
          cursor: pointer;
          transition: all 0.3s ease;
          text-align: left;
        }
        .menu-link-item:hover {
          background: rgba(196, 31, 43, 0.12);
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
          transition: opacity 0.4s ease;
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
          transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          display: flex;
          flex-direction: column;
          box-shadow: -10px 0 35px rgba(0, 0, 0, 0.6);
          padding: 1.5rem;
          box-sizing: border-box;
        }
        .menu-drawer.is-open { transform: translateX(0); }

        /* Hero banner photo (Business Hub › About & Map) */
        .hero-photo {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center center;
          z-index: 0;
          pointer-events: none;
        }
        @media (max-width: 768px) {
          .hero-content h1 { font-size: clamp(1.85rem, 6.5vw, 2.5rem) !important; }

          /* Mobile services collapse toggle */
          .cat-toggle-btn { display: flex !important; }
          .cat-services-grid {
            overflow: hidden;
            transition: max-height 0.7s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.55s ease;
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
          .desktop-nav { display: flex !important; }
          .desktop-actions { display: flex !important; }
          .three-lines-btn { display: none !important; }
          .menu-drawer, .menu-drawer-backdrop { display: none !important; }
        }

        /* Mobile: hide desktop nav and actions, show three-lines hamburger button */
        @media (max-width: 768px) {
          .desktop-nav { display: none !important; }
          .desktop-actions { display: none !important; }
          .three-lines-btn { display: inline-flex !important; }
        }

        .nav-link {
          color: rgba(255, 255, 255, 0.82);
          font-size: 0.8rem;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          cursor: pointer;
          transition: color 0.25s ease;
        }
        .nav-link:hover { color: #C41F2B !important; }

        /* Fluid text - refined desktop sizes so it is not oversized */
        .text-fluid-h1 {
          font-size: clamp(1.85rem, 3.2vw, 3.25rem);
          line-height: 1.05;
          letter-spacing: -1px;
        }
        .text-fluid-h2 {
          font-size: clamp(1.35rem, 2.2vw, 2.15rem);
          line-height: 1.2;
          letter-spacing: 0.5px;
        }
        .text-fluid-body {
          font-size: clamp(0.85rem, 1vw, 1.02rem);
          line-height: 1.7;
        }
      `}</style>

      {/* ── 1. STICKY HEADER ── */}
      <header
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: scrolled ? '64px' : '74px',
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
        {/* LOGO (Left) */}
        <div style={{ flex: 1 }}>
          <div
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
          >
            <img
              src="/comarlogo-Photoroom.png"
              alt={businessName}
              style={{ width: 'clamp(160px, 14vw, 190px)', height: 'auto', display: 'block' }}
            />
          </div>
        </div>

        {/* DESKTOP NAVIGATION (Middle) - Hidden on Mobile */}
        <nav className="desktop-nav" style={{ display: 'flex', gap: 'clamp(1.2rem, 2.2vw, 2.5rem)', alignItems: 'center' }}>
          {NAV_LINKS.map(link => (
            <span
              key={link.id}
              onClick={() => scrollToSection(link.id)}
              className="nav-link"
            >
              {link.label}
            </span>
          ))}
        </nav>

        {/* DESKTOP ACTIONS (Right) - Hidden on Mobile */}
        <div className="desktop-actions" style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', alignItems: 'center' }}>
          <AuthButtons user={user} pending={authActionPending} onAuth={handleAuthAction} onSignOut={() => signOut()} />
        </div>

        {/* THREE-LINES BUTTON - Mobile View Only (media_1790708236894.png) */}
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

      {/* ── 2. MENU DRAWER (shadcn Sheet) ── */}
      <MobileMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        links={NAV_LINKS}
        onNavigate={scrollToSection}
        user={user}
        pending={authActionPending}
        onAuth={handleAuthAction}
        onSignOut={() => { signOut(); setMenuOpen(false); }}
      />

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
          overflow: 'hidden',
          background: '#0A0B0D'
        }}
      >
        {/* Shop photo from the Business Hub, darkened so the headline stays readable; plain dark without one */}
        {heroPhoto && (
          <>
            <img className="hero-photo" src={heroPhoto.url} alt="" fetchPriority="high" decoding="async" />
            <div style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(to bottom, rgba(10,11,13,0.72) 0%, rgba(10,11,13,0.55) 45%, rgba(10,11,13,0.85) 100%)',
              zIndex: 1,
              pointerEvents: 'none'
            }} />
          </>
        )}

        <div className="hero-content" style={{ position: 'relative', zIndex: 2, textAlign: 'center', maxWidth: '850px', padding: '0 2rem' }}>
          <Reveal delay={250} direction="up">
            <h1 className="text-fluid-h1" style={{ fontWeight: '950', textTransform: 'uppercase', marginBottom: '1.25rem' }}>
              TURN THE COLOR <br />
              <span style={{ color: '#C41F2B' }}>TO THE MAXIMUM</span>
            </h1>
          </Reveal>

          <Reveal delay={650} direction="up">
            <p className="text-fluid-body" style={{ color: 'rgba(255,255,255,0.75)', maxWidth: '580px', margin: '0 auto 2.25rem', fontWeight: '500' }}>
              Experience premium automotive detailing services that bring out the true brilliance of your vehicle. Our expert team uses cutting-edge techniques to deliver stunning results.
            </p>
          </Reveal>

          <Reveal delay={1050} direction="up">
            <HeroActions user={user} pending={authActionPending} onAuth={handleBookAction} />
          </Reveal>
        </div>
      </section>

      {/* ── 4. ABOUT SECTION ── */}
      <section id="about" className="section-padding" style={{ background: '#0A0B0D' }}>
        <div className="container-wide" style={{ display: 'grid', gridTemplateColumns: aboutCards.length ? 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))' : 'minmax(0, 52rem)', gap: 'clamp(2rem, 5vw, 4.5rem)', alignItems: 'center' }}>
          <Reveal direction="right">
            <h2 className="text-fluid-h2" style={{ textTransform: 'uppercase', marginBottom: '1.5rem', fontWeight: 950 }}>{about.heading}</h2>
            {about.body.split(/\n{2,}/).map((para, index) => (
              <p key={index} style={{ fontSize: 'clamp(0.92rem, 1.05vw, 1.05rem)', color: 'rgba(255,255,255,0.65)', lineHeight: '1.75', marginBottom: '1.5rem', whiteSpace: 'pre-line' }}>
                {para}
              </p>
            ))}
          </Reveal>

          {aboutCards.length > 0 && (
            <Reveal direction="up" delay={150}>
              <AboutFeatures items={aboutCards} />
            </Reveal>
          )}
        </div>

        {/* Photos and map, managed in Business Hub › About & Map */}
        {(aboutPhotos.length > 0 || shopLocation) && (
          <div className="container-wide" style={{ display: 'grid', gap: 'clamp(2rem, 4vw, 3rem)', marginTop: 'clamp(2.5rem, 5vw, 4rem)' }}>
            {aboutPhotos.length > 0 && (
              <Reveal direction="up">
                <AboutGallery photos={aboutPhotos} layout={settings?.ABOUT_LAYOUT} />
              </Reveal>
            )}
            {shopLocation && (
              <Reveal direction="up">
                <div style={{ display: 'grid', gap: '0.85rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <MapPin size={18} color="#C41F2B" aria-hidden="true" /> Find us
                    </h3>
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${shopLocation.lat},${shopLocation.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#C41F2B', fontSize: '0.8rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', textDecoration: 'none' }}
                    >
                      Get directions
                    </a>
                  </div>
                  <ShopMap location={shopLocation} height={320} label={`Map showing ${shopLocation.label || businessName}`} />
                  {shopLocation.label && <p style={{ margin: 0, color: 'rgba(255,255,255,0.65)', fontSize: '0.9rem' }}>{shopLocation.label}</p>}
                </div>
              </Reveal>
            )}
          </div>
        )}
      </section>

      {/* ── 5. SERVICES SHOWCASE & DEDICATED CATALOG LINK ── */}
      <section id="services" className="section-padding" style={{ background: '#0F1012' }}>
        <div className="container-wide">
          <Reveal direction="up">
            <div style={{ textAlign: 'center', marginBottom: '3.5rem' }}>
              <h2 className="text-fluid-h2" style={{ textTransform: 'uppercase', marginBottom: '1rem', fontWeight: 950 }}>OUR SERVICES & PACKAGES</h2>
              <p style={{ maxWidth: '640px', margin: '0 auto 1.5rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.95rem', lineHeight: 1.6 }}>
                From precision car washing and interior restoration to multi-stage paint correction and ceramic protection. Explore our dedicated catalog for full vehicle class pricing and package options.
              </p>
              <div style={{ width: '80px', height: '4px', background: '#C41F2B', margin: '0 auto', borderRadius: '2px' }} />
            </div>
          </Reveal>

          {/* Featured highlights preview grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1.5rem', marginBottom: '3rem' }}>
            {featuredServices.map((service, i) => (
              <Reveal key={service.id || i} delay={i * 80} direction="up">
                <ServiceCard service={service} formatPrice={formatPrice} />
              </Reveal>
            ))}
          </div>

          {/* CTA Banner linking to /services */}
          <Reveal direction="up" delay={200}>
            <div style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(196, 31, 43, 0.08) 100%)',
              border: '1.5px solid rgba(255,255,255,0.12)',
              borderRadius: '16px',
              padding: 'clamp(2rem, 4vw, 3rem)',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '1.25rem'
            }}>
              <div>
                <h3 style={{ fontSize: 'clamp(1.2rem, 2.5vw, 1.6rem)', fontWeight: 950, textTransform: 'uppercase', margin: '0 0 0.5rem', color: '#fff' }}>
                  See Our Packages
                </h3>
                <p style={{ margin: 0, color: 'rgba(255,255,255,0.75)', fontSize: '0.92rem', maxWidth: '580px' }}>
                  Browse our bundled packages and their prices for every vehicle type. Create a free account to see every service we offer.
                </p>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', justifyContent: 'center' }}>
                <button
                  type="button"
                  onClick={() => navigate('/services')}
                  style={{
                    background: '#C41F2B',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '0.9rem 1.75rem',
                    fontSize: '0.88rem',
                    fontWeight: 900,
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    boxShadow: '0 6px 20px rgba(196, 31, 43, 0.35)',
                    transition: 'all 0.3s ease'
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 25px rgba(196, 31, 43, 0.5)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 6px 20px rgba(196, 31, 43, 0.35)'; }}
                >
                  <span>View Packages & Pricing</span>
                  <ChevronRight size={18} />
                </button>

                <button
                  type="button"
                  onClick={handleBookAction}
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    color: '#fff',
                    border: '1.5px solid rgba(255,255,255,0.2)',
                    borderRadius: '8px',
                    padding: '0.9rem 1.75rem',
                    fontSize: '0.88rem',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    transition: 'all 0.3s ease'
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                >
                  <span>Book Appointment</span>
                </button>
              </div>
            </div>
          </Reveal>
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

          <FaqList faqs={displayFaqs} />
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
            <ContactCards items={contactItems} />
          </Reveal>

          <Reveal direction="left" delay={150}>
            <ContactForm />
          </Reveal>
        </div>
      </section>

      {/* ── 8. FOOTER ── */}
      <SiteFooter
        businessName={businessName}
        links={NAV_LINKS}
        onNavigate={scrollToSection}
        socials={[{ label: 'Facebook', icon: Facebook }, { label: 'Instagram', icon: Instagram }, { label: 'Twitter', icon: Twitter }]}
      />

      {/* LOGIN MODAL */}
      {showLoginModal && <Login isModal next={loginNext} onClose={() => setShowLoginModal(false)} />}
    </div>
  );
};

export default Landing;
