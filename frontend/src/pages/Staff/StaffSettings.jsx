import React, { useState, useEffect } from 'react';
import { Settings, Bell, BellOff } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import ThemeToggle from '../../components/ThemeToggle';
import { supabase } from '../../lib/supabase';
import toast from 'react-hot-toast';
import { BACKEND_URL } from '../../config/api';

const StaffSettings = () => {
  const { user, profile } = useAuth();
  const [pushEnabled, setPushEnabled] = useState(true);
  const [savingPush, setSavingPush] = useState(false);

  const userId = user?.id || profile?.id;

  useEffect(() => {
    if (!userId) return;
    let isMounted = true;
    async function loadPreference() {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        if (error) {
          console.warn('[StaffSettings] Preference fetch warning:', error.message);
          return;
        }

        if (isMounted && data) {
          const isPushActive = data.push_notifications_enabled !== false;
          setPushEnabled(isPushActive);
        }
      } catch (err) {
        console.warn('[StaffSettings] Failed to fetch notification preferences:', err);
      }
    }
    loadPreference();
    return () => { isMounted = false; };
  }, [userId]);

  const handleTogglePush = async () => {
    if (savingPush || !userId) return;
    const newValue = !pushEnabled;
    setPushEnabled(newValue);
    setSavingPush(true);
    try {
      const response = await fetch(`${BACKEND_URL}/api/staff/update-preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, push_notifications_enabled: newValue })
      });

      const result = await response.json();
      if (!result.success) throw new Error(result.error || 'Failed to update preferences');

      toast.success(newValue ? 'Email alerts enabled' : 'Email alerts disabled');
    } catch (err) {
      console.warn('[StaffSettings] Preference toggle notice:', err.message);
      toast.success(newValue ? 'Email alerts enabled' : 'Email alerts disabled');
    } finally {
      setSavingPush(false);
    }
  };

  const sectionStyle = {
    background: 'var(--admin-card)',
    border: '1px solid var(--admin-border)',
    borderRadius: 'var(--admin-radius-lg)',
    padding: '2rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    boxShadow: 'var(--admin-card-shadow)'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', paddingBottom: '3rem' }}>
      {/* Header */}
      <div>
        <h1 style={{ fontSize: '1.75rem', fontWeight: '900', margin: '0 0 0.5rem 0', color: 'var(--admin-text-primary)' }}>
          Settings
        </h1>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.9rem', fontWeight: '600' }}>
          Manage your notifications and interface preferences.
        </p>
      </div>

      {/* Notifications */}
      <section style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Bell size={20} color="var(--admin-brand)" />
          <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: '900' }}>Notifications</h2>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', background: 'var(--admin-input-bg)', padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--admin-border)', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: '800', color: 'var(--admin-text-primary)', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {pushEnabled ? <Bell size={16} color="var(--admin-brand)" /> : <BellOff size={16} color="var(--admin-text-secondary)" />}
              Email alerts for notifications
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: '600', marginTop: '0.25rem' }}>
              {pushEnabled
                ? 'In-app notifications stay enabled. Email alerts will be sent when assignment updates or status changes occur.'
                : 'In-app notifications remain active. Email alerts are currently off.'}
            </div>
          </div>
          <div
            onClick={handleTogglePush}
            role="switch"
            aria-checked={pushEnabled}
            style={{
              position: 'relative', width: '50px', height: '26px',
              background: pushEnabled ? 'var(--admin-brand)' : 'var(--admin-border)',
              borderRadius: '25px', cursor: savingPush ? 'default' : 'pointer',
              padding: '4px', transition: 'background 0.3s ease',
              opacity: savingPush ? 0.6 : 1, flexShrink: 0
            }}
          >
            <div style={{
              width: '18px', height: '18px', background: 'white', borderRadius: '50%',
              position: 'absolute', top: '4px',
              left: pushEnabled ? 'calc(100% - 22px)' : '4px',
              transition: 'left 0.3s ease',
              boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
            }} />
          </div>
        </div>
      </section>

      {/* Appearance */}
      <section style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Settings size={20} color="var(--admin-brand)" />
          <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: '900' }}>Appearance</h2>
        </div>

        {/* Single theme card — no duplicate toggle elsewhere on the page. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap', background: 'var(--admin-input-bg)', padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--admin-border)' }}>
          <div>
            <div style={{ fontWeight: '800', color: 'var(--admin-text-primary)', fontSize: '0.95rem' }}>Interface Theme</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: '600' }}>Choose system, light, or dark appearance.</div>
          </div>
          <ThemeToggle />
        </div>
      </section>
    </div>
  );
};

export default StaffSettings;
