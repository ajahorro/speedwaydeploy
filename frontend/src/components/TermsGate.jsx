import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '@/lib/toast';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { useConfig } from '../context/ConfigContext';

const roleKey = (role) => {
  const value = String(role || '').toUpperCase();
  if (value === 'STAFF') return 'staff';
  if (value === 'ADMIN' || value === 'SUPER_ADMIN') return 'admin';
  return 'customer';
};

/** True while the signed-in account still has to accept its current terms. */
export const isTermsPending = (profile, settings) => {
  const terms = settings?.TERMS?.[roleKey(profile?.role)];
  const text = String(terms?.text || '').trim();
  return Boolean(profile?.id && text && Number(profile.accepted_terms_version || 0) < Number(terms?.version || 1));
};

const TITLES = { customer: 'Customer Terms & Conditions', staff: 'Staff Terms & Conditions', admin: 'Administrator Terms & Conditions' };

/**
 * First-open terms and conditions (master plan 1.11). Shows the signed-in role's own text
 * over the account until its current version is accepted. The checkbox and the Accept button
 * appear only after the person has scrolled to the end. The only other way out is signing out.
 */
const TermsGate = () => {
  const { profile, signOut, fetchProfile } = useAuth();
  const { settings } = useConfig();
  const bodyRef = useRef(null);
  const [atEnd, setAtEnd] = useState(false);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  const key = roleKey(profile?.role);
  const terms = settings?.TERMS?.[key];
  const text = String(terms?.text || '').trim();
  const version = Number(terms?.version || 1);
  const needsAcceptance = Boolean(profile?.id && text && Number(profile.accepted_terms_version || 0) < version);

  const checkEnd = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 4) setAtEnd(true);
  }, []);

  useEffect(() => {
    if (!needsAcceptance) return undefined;
    setAtEnd(false);
    setChecked(false);
    const timer = setTimeout(checkEnd, 50); // short texts that already fit need no scrolling
    return () => clearTimeout(timer);
  }, [needsAcceptance, version, key, checkEnd]);

  if (!needsAcceptance) return null;

  const accept = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.rpc('accept_terms');
      if (error) throw error;
      await fetchProfile(profile.id, 'TERMS_ACCEPTED', true);
    } catch (error) {
      toast.error(error?.message || 'Could not record your acceptance. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="terms-gate-title" style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div style={{ width: '100%', maxWidth: '620px', maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-lg)', boxShadow: '0 20px 45px rgba(0,0,0,0.45)', overflow: 'hidden' }}>
        <div style={{ padding: '1rem 1.25rem', background: 'var(--admin-sidebar)', borderBottom: '1px solid var(--admin-border)' }}>
          <h3 id="terms-gate-title" style={{ margin: 0, color: 'var(--admin-text-primary)', fontSize: '1rem', fontWeight: 950, textTransform: 'uppercase' }}>{TITLES[key]}</h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: 600 }}>Please read these terms before you continue.</p>
        </div>
        <div ref={bodyRef} onScroll={checkEnd} tabIndex={0} style={{ padding: '1.25rem', overflowY: 'auto', flex: 1, minHeight: 0, color: 'var(--admin-text-primary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
          {text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line, index) => <p key={index} style={{ margin: '0 0 0.75rem' }}>{line}</p>)}
        </div>
        <div style={{ padding: '1rem 1.25rem', borderTop: '1px solid var(--admin-border)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {!atEnd ? (
            <p role="status" style={{ margin: 0, fontSize: '0.8rem', fontWeight: 800, color: 'var(--admin-text-secondary)' }}>Scroll to the end to continue.</p>
          ) : (
            <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', fontSize: '0.85rem', fontWeight: 700, color: 'var(--admin-text-primary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} style={{ marginTop: '0.2rem' }} />
              I have read and agree to the terms and conditions.
            </label>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => signOut()} style={{ padding: '0.75rem 1.1rem', background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)', borderRadius: 'var(--admin-radius-md)', fontWeight: 900, cursor: 'pointer' }}>Sign out</button>
            {atEnd && (
              <button type="button" onClick={accept} disabled={!checked || saving} style={{ padding: '0.75rem 1.4rem', background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: 'none', borderRadius: 'var(--admin-radius-md)', fontWeight: 950, cursor: !checked || saving ? 'not-allowed' : 'pointer', opacity: !checked || saving ? 0.5 : 1 }}>
                {saving ? 'Saving…' : 'Accept and continue'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TermsGate;
