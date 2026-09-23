import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import {
  Save, Gauge, RefreshCcw, ArrowRight, Sparkles, Building2, Users, Wrench, CreditCard
} from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../../components/PageHeader';
import { useTheme } from '../../context/ThemeContext';
import { useConfig } from '../../context/ConfigContext';
import { useAuth } from '../../hooks/useAuth';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { logger } from '../../utils/logger';

// Tier 2.10 / 2.11 — SINGLE SOURCE OF TRUTH.
// Business Hub (/admin/business) owns the business_config row: business identity,
// hours, capacity, schedule rules, the service catalog, FAQs and the QR/GCash
// payment recipients (qr_account_* / fallback_receiver_*). This page once wrote a
// DIFFERENT set of columns for the same row (gcash_* / payment_account_*), which
// clobbered the hub's fields on every save. Those editors are retired here; the
// remaining controls (business identity, hours, capacity) write the SAME column
// names Business Hub uses, so the two pages can never fight over the row again.
const AdminSettings = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { refreshConfig } = useConfig();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);

  const [settings, setSettings] = useState({
    business_name: '',
    contact_number: '',
    email_address: '',
    business_address: '',
    opening_hour: '',
    closing_hour: '',
    slots_per_hour: 2,
    max_vehicles_per_staff: 4
  });

  // Helper to convert "08:00 AM" to "08:00" for time input
  const formatForInput = (timeStr) => {
    if (!timeStr) return "08:00";
    if (/^\d{2}:\d{2}$/.test(timeStr)) return timeStr;
    const parts = timeStr.split(' ');
    if (parts.length !== 2) return timeStr;
    const [time, modifier] = parts;
    let [hours, minutes] = time.split(':');
    if (modifier === 'PM' && hours !== '12') hours = parseInt(hours, 10) + 12;
    if (modifier === 'AM' && hours === '12') hours = '00';
    return `${hours.toString().padStart(2, '0')}:${minutes}`;
  };

  const fetchSettings = async () => {
    setFetching(true);
    try {
      logger.admin('Fetching global studio configuration...');
      const { data, error } = await supabase
        .from('business_config')
        .select('*')
        .limit(1)
        .single();

      if (error) {
        // Fallback to local storage
        const saved = localStorage.getItem('speedway_business_settings');
        if (saved) {
          const parsed = JSON.parse(saved);
          setSettings(prev => ({ 
            ...prev, 
            ...parsed,
            opening_hour: formatForInput(parsed.opening_hour),
            closing_hour: formatForInput(parsed.closing_hour),
            max_vehicles_per_staff: Number(parsed.max_vehicles_per_staff) || 4
          }));
        }
        logger.warn('Using local settings fallback.');
      } else {
        setSettings({
          business_name: data.business_name || '',
          contact_number: data.contact_number || '',
          email_address: data.email_address || '',
          business_address: data.business_address || '',
          opening_hour: formatForInput(data.opening_hour),
          closing_hour: formatForInput(data.closing_hour),
          slots_per_hour: data.slots_per_hour || 2,
          max_vehicles_per_staff: Number(data.max_vehicles_per_staff) || 4
        });
        logger.admin('Global studio parameters synchronized.');
      }
    } catch (err) {
      logger.error('Fetch Settings Error', err);
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleSave = async () => {
    setLoading(true);
    try {
      logger.admin('Updating global business parameters...');

      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!session?.user) throw new Error('No active admin session. Please sign in again.');
      if (profile?.role?.toUpperCase() !== 'ADMIN') throw new Error('Admin access is required to save company settings.');

      const { error } = await supabase
        .from('business_config')
        .upsert({
          id: settings.id || 1,
          business_name: settings.business_name,
          contact_number: settings.contact_number,
          email_address: settings.email_address,
          business_address: settings.business_address,
          opening_hour: settings.opening_hour,
          closing_hour: settings.closing_hour,
          // NOTE: qr_account_* / fallback_receiver_* (payment), custom_services and
          // faqs are owned by the Business Hub and deliberately omitted here so
          // this page can never blank them (Tier 2.10).
          slots_per_hour: settings.slots_per_hour,
          max_vehicles_per_staff: Number(settings.max_vehicles_per_staff) || 4,
          updated_at: new Date().toISOString()
        });

      if (error) throw error;

      localStorage.setItem('speedway_business_settings', JSON.stringify({ ...settings, max_vehicles_per_staff: Number(settings.max_vehicles_per_staff) || 4 }));
      await refreshConfig();
      toast.success('Global settings updated successfully!');
      logger.admin('Global parameters committed to database.');
    } catch (err) {
      logger.error('Settings Save Error', err);
      toast.error('Failed to sync with database.');
    } finally {
      setLoading(false);
    }
  };

  const sectionStyle = {
    background: 'var(--admin-card)',
    borderRadius: '4px',
    border: '1px solid var(--admin-border)',
    padding: '2rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    color: 'var(--admin-text-primary)'
  };

  const labelStyle = {
    display: 'block',
    fontSize: '0.65rem',
    fontWeight: '950',
    color: 'var(--admin-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '1px',
    marginBottom: '0.5rem'
  };

  const inputStyle = {
    width: '100%',
    padding: '0.75rem 1rem',
    background: 'var(--admin-bg)',
    border: '1px solid var(--admin-border)',
    borderRadius: '4px',
    color: 'var(--admin-text-primary)',
    fontSize: '0.9rem',
    outline: 'none',
    fontWeight: '700'
  };

  if (fetching) return <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--admin-text-secondary)', fontWeight: '950' }}>SYNCHRONIZING STUDIO PARAMETERS...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', paddingBottom: '3rem' }}>
      <PageHeader 
        badge="STUDIO CONFIGURATION"
        title="Business Settings and Logistics"
        subtitle="Operational parameters, business hours, and capacity. Catalog, FAQs, and payment recipients live in the Business Hub."
        onRefresh={fetchSettings}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', alignItems: 'stretch' }}>
        
        {/* Business Settings Module */}
        <div style={{ ...sectionStyle, width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <Building2 size={20} color="var(--admin-brand)" />
            <h2 style={{ fontSize: '1rem', fontWeight: '950', margin: 0, textTransform: 'uppercase', letterSpacing: '1px' }}>Business Settings</h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.25rem' }}>
            <div>
              <label style={labelStyle}>Business Name</label>
              <input 
                type="text" 
                value={settings.business_name}
                onChange={(e) => setSettings({...settings, business_name: e.target.value})}
                style={inputStyle} 
              />
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '1rem' }}>
              <div>
                <label style={labelStyle}>Contact Number</label>
                <input 
                  type="text" 
                  value={settings.contact_number}
                  onChange={(e) => setSettings({...settings, contact_number: e.target.value})}
                  style={inputStyle} 
                />
              </div>
              <div>
                <label style={labelStyle}>Email Address</label>
                <input 
                  type="email" 
                  value={settings.email_address}
                  onChange={(e) => setSettings({...settings, email_address: e.target.value})}
                  style={inputStyle} 
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Business Address</label>
              <textarea 
                value={settings.business_address}
                onChange={(e) => setSettings({...settings, business_address: e.target.value})}
                style={{ ...inputStyle, minHeight: '80px', resize: 'vertical', fontFamily: 'inherit' }} 
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label style={labelStyle}>Opening Hour</label>
                <input 
                  type="time" 
                  value={settings.opening_hour}
                  onChange={(e) => setSettings({...settings, opening_hour: e.target.value})}
                  style={inputStyle} 
                />
              </div>
              <div>
                <label style={labelStyle}>Closing Hour</label>
                <input 
                  type="time" 
                  value={settings.closing_hour}
                  onChange={(e) => setSettings({...settings, closing_hour: e.target.value})}
                  style={inputStyle} 
                />
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--admin-border)', paddingTop: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Gauge size={20} color="var(--admin-brand)" />
                <h3 style={{ margin: 0, fontSize: '0.85rem', fontWeight: '950', textTransform: 'uppercase' }}>Capacity &amp; Scheduling</h3>
              </div>
              <p style={{ margin: '0.75rem 0 0', fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: 600, lineHeight: 1.6 }}>
                The hour-by-hour capacity and per-staff vehicle limits are configured in the Business Hub under Hours &amp; Capacity. This page keeps the business identity only, to avoid duplicated writes to the same configuration row.
              </p>
            </div>

            {/* Tier 2.10: service catalog now lives in the Business Hub only. */}
            <div style={{ borderTop: '1px solid var(--admin-border)', paddingTop: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Wrench size={20} color="var(--admin-brand)" />
                <h3 style={{ margin: 0, fontSize: '0.85rem', fontWeight: '950', textTransform: 'uppercase' }}>Service Catalog &amp; FAQs</h3>
              </div>
              <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: 600, lineHeight: 1.6 }}>
                The service catalog, its pricing, and the landing-page FAQs are managed centrally in the Business Hub.
              </p>
              <button
                type="button"
                onClick={() => navigate('/admin/business?tab=services')}
                style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.7rem 1.1rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', borderRadius: '4px', fontWeight: 950, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer' }}
              >
                Open Service Catalog <ArrowRight size={15} />
              </button>
            </div>

            <button 
              onClick={handleSave}
              disabled={loading}
              style={{ 
                marginTop: '1rem', padding: '0.85rem', background: 'var(--admin-brand)', 
                color: 'var(--admin-text-primary)', borderRadius: '4px', fontSize: '0.75rem', 
                fontWeight: '950', cursor: 'pointer', textTransform: 'uppercase'
              }}
            >
              {loading ? 'SYNCHRONIZING...' : 'COMMIT CHANGES'}
            </button>
          </div>
        </div>

        {/* Payment & Infrastructure */}
        <div style={{ ...sectionStyle, width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <CreditCard size={20} color="var(--admin-brand)" />
            <h2 style={{ fontSize: '1rem', fontWeight: '950', margin: 0, textTransform: 'uppercase', letterSpacing: '1px' }}>Payment Infrastructure</h2>
          </div>

          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: 600, lineHeight: 1.6 }}>
            The QR / GCash payment recipients (account name, account number, and fallback receiver) are owned by the Business Hub so they stay in sync with checkout. Changing them requires email OTP verification.
          </p>
          <button
            type="button"
            onClick={() => navigate('/admin/business?tab=profile')}
            style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.7rem 1.1rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', borderRadius: '4px', fontWeight: 950, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer' }}
          >
            Manage Payment Recipients <ArrowRight size={15} />
          </button>

          <div style={{ borderTop: '1px solid var(--admin-border)', paddingTop: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
              <Sparkles size={20} color="var(--admin-brand)" />
              <h3 style={{ fontSize: '0.85rem', fontWeight: '950', margin: 0, textTransform: 'uppercase' }}>System Appearance</h3>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
              {['system', 'light', 'dark'].map(t => (
                <button
                  key={t}
                  onClick={() => toggleTheme(t)}
                  style={{
                    padding: '0.75rem', background: theme === t ? 'var(--admin-brand)' : 'var(--admin-bg)',
                    color: theme === t ? '#fff' : 'var(--admin-text-primary)',
                    border: '1px solid var(--admin-border)', borderRadius: '4px', fontSize: '0.75rem', fontWeight: '950', cursor: 'pointer', textTransform: 'uppercase'
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

export default AdminSettings;
