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
  const [menuOpen, setMenuOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState(null);
  const [openService, setOpenService] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  // Track which service categories are collapsed on mobile (all collapsed by default)
  const [collapsedCategories, setCollapsedCategories] = useState({});
  const { user, profile, signOut, isInitialized, loading: authLoading } = useAuth();
  const { settings } = useConfig();
  const navigate = useNavigate();
  const authActionPending = Boolean(user && (!isInitialized || authLoading));

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
    if (!user) {
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

        /* Hero video — zoom to cover screen gracefully */
        .hero-video {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center center;
          z-index: 0;
          opacity: 0.55;
          pointer-events: none;
        }
        @media (max-width: 768px) {
          .hero-video {
            /* Mobile phone view: zoom to fit phone screen edge-to-edge properly */
            object-fit: cover;
            object-position: center center;
            width: 100%;
            height: 100%;
            opacity: 0.58;
          }
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
          background: 'radial-gradient(ellipse at center, rgba(169, 27, 24, 0.22) 0%, rgba(10, 11, 13, 0.88) 65%, #0A0B0D 100%)'
        }}
      >
        {/* Background video — zoom to fit phone screen on mobile, cover widescreen on desktop */}
        <video
          className="hero-video"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
        >
          <source src="/S7ggroup_pindown.io_1790707925.mp4" type="video/mp4" />
          <source src="/hero-bg.mp4" type="video/mp4" />
        </video>

        {/* Gradient overlay so text stays readable */}
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to bottom, rgba(10,11,13,0.5) 0%, rgba(10,11,13,0.25) 50%, rgba(10,11,13,0.7) 100%)',
          zIndex: 1,
          pointerEvents: 'none'
        }} />

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
            <HeroActions user={user} pending={authActionPending} onAuth={handleAuthAction} />
          </Reveal>
        </div>
      </section>

      {/* ── 4. ABOUT SECTION ── */}
      <section id="about" className="section-padding" style={{ background: '#0A0B0D' }}>
        <div className="container-wide" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 'clamp(2rem, 5vw, 4.5rem)', alignItems: 'center' }}>
          <Reveal direction="right">
            <h2 className="text-fluid-h2" style={{ textTransform: 'uppercase', marginBottom: '1.5rem', fontWeight: 950 }}>ABOUT US</h2>
            <p style={{ fontSize: 'clamp(0.92rem, 1.05vw, 1.05rem)', color: 'rgba(255,255,255,0.65)', lineHeight: '1.75', marginBottom: '1.5rem' }}>
              At Comar Garage, we believe that every vehicle deserves to look its absolute best.
              Founded with a passion for automotive excellence, we have grown into one of the region's
              most trusted detailing centers.
            </p>
          </Reveal>

          <Reveal direction="up" delay={150}>
            <AboutFeatures items={[
              { icon: Shield, title: 'Protection', desc: 'Premium ceramic coatings' },
              { icon: Zap, title: 'Performance', desc: 'Expert technicians' },
              { icon: Star, title: 'Quality', desc: 'Satisfaction guaranteed' },
              { icon: Clock, title: 'Reliability', desc: 'Punctual service' },
            ]} />
          </Reveal>
        </div>
      </section>

      {/* ── 5. SERVICES SECTION ── */}
      <section id="services" className="section-padding" style={{ background: '#0F1012' }}>
        <div className="container-wide">
          <Reveal direction="up">
            <div style={{ textAlign: 'center', marginBottom: '4.5rem' }}>
              <h2 className="text-fluid-h2" style={{ textTransform: 'uppercase', marginBottom: '1rem', fontWeight: 950 }}>OUR SERVICES</h2>
              <div style={{ width: '80px', height: '4px', background: '#C41F2B', margin: '0 auto', borderRadius: '2px' }} />
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
                        background: 'rgba(196, 31, 43,0.1)',
                        border: '1px solid rgba(196, 31, 43,0.25)',
                        borderRadius: '2px',
                        color: '#C41F2B',
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
                        <ServiceCard service={service} formatPrice={formatPrice} />
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
      {showLoginModal && <Login isModal onClose={() => setShowLoginModal(false)} />}
    </div>
  );
};

export default Landing;
