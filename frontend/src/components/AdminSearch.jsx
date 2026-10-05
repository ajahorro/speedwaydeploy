import React, { useState, useEffect, useRef } from 'react';
import { Search, FileText, User, CreditCard, Bell, Settings, LayoutDashboard, Calendar, History, ClipboardList, Shield, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { logger } from '../utils/logger';
import { matchesSearchText, escapeForPostgrestFilter } from '../utils/searchMatch';

// Static route table. Hoisted to MODULE scope so its identity is stable across
// renders — declared inside the component it was a NEW array on every render,
// which is what put it in the search effect's dependency graph.
const PAGES = [
  { name: 'Dashboard', path: '/admin', icon: LayoutDashboard, category: 'Pages' },
  { name: 'Booking Management', path: '/admin/bookings', icon: ClipboardList, category: 'Pages' },
  { name: 'Payment Verification', path: '/admin/payments', icon: CreditCard, category: 'Pages' },
  { name: 'Schedule', path: '/admin/schedule', icon: Calendar, category: 'Pages' },
  { name: 'Refund Hub', path: '/admin/refunds', icon: ClipboardList, category: 'Pages' },
  { name: 'Analytics', path: '/admin/analytics', icon: LayoutDashboard, category: 'Pages' },
  { name: 'Audit Logs', path: '/admin/audit-logs', icon: History, category: 'Pages' },
  { name: 'Staff & Admin Accounts', path: '/admin/accounts', icon: User, category: 'Pages' },
  { name: 'Business Hub', path: '/admin/business', icon: Settings, category: 'Pages' },
  { name: 'Walk-in Booking', path: '/admin/walk-in', icon: ClipboardList, category: 'Pages' },
  { name: 'Users', path: '/admin/users', icon: User, category: 'Pages' },
  { name: 'Notifications', path: '/admin/notifications', icon: Bell, category: 'Pages' },
  { name: 'Settings', path: '/admin/settings', icon: Settings, category: 'Pages' },
  { name: 'Profile', path: '/admin/profile', icon: Shield, category: 'Pages' },
];

const AdminSearch = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [searched, setSearched] = useState(false);
  const navigate = useNavigate();
  const searchRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const performSearch = async () => {
      const text = query.trim();
      if (text.length < 2) {
        setResults([]);
        setSearched(false);
        setIsOpen(false);
        return;
      }

      try {
        logger.admin(`Searching for: ${text}`);
        const safe = escapeForPostgrestFilter(text);
        const like = `%${safe}%`;
        const hex = text.replace(/^#/, '');
        const looksLikeId = /^[0-9a-f-]{4,36}$/i.test(hex);

        const [pageHits, bookingsByText, vehicleHits, users, recentIds] = await Promise.all([
          Promise.resolve(PAGES.filter(p => matchesSearchText(text, p.name))),
          safe
            ? supabase
              .from('bookings')
              .select('id, status, customer_name, guest_name, customer:profiles!bookings_customer_id_fkey(full_name)')
              .or(`customer_name.ilike.${like},guest_name.ilike.${like},customer_email.ilike.${like},contact_number.ilike.${like}`)
              .order('created_at', { ascending: false })
              .limit(5)
            : Promise.resolve({ data: [] }),
          safe
            ? supabase
              .from('booking_vehicles')
              .select('booking_id, plate_number, brand, model')
              .or(`plate_number.ilike.${like},brand.ilike.${like},model.ilike.${like}`)
              .limit(5)
            : Promise.resolve({ data: [] }),
          safe
            ? supabase
              .from('profiles')
              .select('full_name, role, id, email')
              .or(`full_name.ilike.${like},email.ilike.${like},phone_number.ilike.${like}`)
              .limit(5)
            : Promise.resolve({ data: [] }),
          // Booking IDs are shown shortened (#A1B2C3D4); a UUID prefix cannot be
          // filtered in SQL, so match it against the latest bookings instead.
          looksLikeId
            ? supabase.from('bookings').select('id, status, customer_name, guest_name').order('created_at', { ascending: false }).limit(300)
            : Promise.resolve({ data: [] })
        ]);
        if (cancelled) return;

        const bookingMap = new Map();
        const label = (b) => b.customer_name || b.customer?.full_name || b.guest_name || 'Customer';
        (recentIds.data || [])
          .filter(b => b.id.toLowerCase().startsWith(hex.toLowerCase()))
          .slice(0, 5)
          .forEach(b => bookingMap.set(b.id, `Booking #${b.id.slice(0, 8).toUpperCase()} - ${label(b)}`));
        (bookingsByText.data || []).forEach(b => {
          if (!bookingMap.has(b.id)) bookingMap.set(b.id, `Booking #${b.id.slice(0, 8).toUpperCase()} - ${label(b)}`);
        });
        (vehicleHits.data || []).forEach(v => {
          if (v.booking_id && !bookingMap.has(v.booking_id)) {
            bookingMap.set(v.booking_id, `Booking #${v.booking_id.slice(0, 8).toUpperCase()} - ${[v.brand, v.model, v.plate_number].filter(Boolean).join(' ')}`);
          }
        });

        const bookingResults = [...bookingMap.entries()].slice(0, 6).map(([id, name]) => ({
          name,
          path: `/admin/bookings/${id}`,
          icon: FileText,
          category: 'Recent Bookings'
        }));

        const userResults = (users.data || []).map(u => ({
          name: `${u.full_name || u.email} (${u.role})`,
          path: String(u.role).toUpperCase() === 'CUSTOMER' ? '/admin/users' : '/admin/accounts',
          icon: User,
          category: 'Users & Staff'
        }));

        setResults([...pageHits, ...bookingResults, ...userResults]);
        setSearched(true);
        setIsOpen(true);
      } catch (err) {
        logger.error('Global Search Error', err);
      }
    };

    const timeoutId = setTimeout(performSearch, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [query]);

  const handleSelect = (path) => {
    navigate(path);
    setQuery('');
    setIsOpen(false);
  };

  return (
    <div ref={searchRef} className="portal-search-control" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <Search size={16} style={{ position: 'absolute', left: '1rem', color: 'var(--admin-text-secondary)', opacity: 0.5, zIndex: 10 }} />
      <input
        className="portal-search-input"
        type="text" 
        placeholder="SYSTEM SEARCH..." 
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => query.length > 0 && setIsOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setIsOpen(false);
          if (e.key === 'Enter' && results[0]) handleSelect(results[0].path);
        }}
        style={{ 
          padding: '0.65rem 1rem 0.65rem 2.75rem', 
          borderRadius: 'var(--admin-radius-sm)', 
          background: 'var(--admin-bg)', 
          border: '1px solid var(--admin-border)', 
          color: 'var(--admin-text-primary)',
          fontSize: '0.75rem',
          fontWeight: '950',
          width: '320px',
          outline: 'none',
          transition: '0.2s',
          letterSpacing: '0.5px'
        }} 
      />

      {isOpen && searched && results.length === 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '0.5rem', padding: '0.9rem 1rem', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', color: 'var(--admin-text-secondary)', fontSize: '0.75rem', fontWeight: 700, zIndex: 2000 }}>
          No matches for "{query.trim()}"
        </div>
      )}

      {isOpen && results.length > 0 && (
        <div style={{ 
          position: 'absolute', 
          top: '100%', 
          left: 0, 
          right: 0, 
          background: 'var(--admin-card)', 
          border: '1px solid var(--admin-border)', 
          borderRadius: 'var(--admin-radius-sm)', 
          boxShadow: 'var(--admin-card-shadow)', 
          marginTop: '0.5rem',
          zIndex: 2000,
          maxHeight: '400px',
          overflowY: 'auto'
        }}>
          {['Pages', 'Recent Bookings', 'Users & Staff'].map(category => {
            const catResults = results.filter(r => r.category === category);
            if (catResults.length === 0) return null;
            
            return (
              <div key={category} style={{ borderBottom: '1px solid var(--admin-border)' }}>
                <div style={{ padding: '0.75rem 1rem', fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-brand)', textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.8 }}>{category}</div>
                {catResults.map((res, idx) => {
                  const Icon = res.icon;
                  return (
                    <div 
                      key={idx}
                      onClick={() => handleSelect(res.path)}
                      style={{ 
                        padding: '0.75rem 1rem', 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '0.75rem', 
                        cursor: 'pointer',
                        transition: '0.2s',
                        background: 'transparent'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <Icon size={14} style={{ color: 'var(--admin-text-secondary)' }} />
                      <div style={{ fontSize: '0.75rem', fontWeight: '700', color: 'var(--admin-text-primary)', flex: 1 }}>{res.name}</div>
                      <ArrowRight size={12} style={{ color: 'var(--admin-text-secondary)', opacity: 0.3 }} />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default AdminSearch;
