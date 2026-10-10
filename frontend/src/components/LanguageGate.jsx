import { useState } from 'react';
import toast from '@/lib/toast';
import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '../hooks/useAuth';
import { useConfig } from '../context/ConfigContext';
import { LANGUAGES, useLanguage } from '../context/LanguageContext';
import { isTermsPending } from './TermsGate';

/**
 * Asked once for every new account (customer, staff and administrator), right after the terms and conditions
 * are accepted. The choice can be changed any time in Settings.
 */
const LanguageGate = () => {
  const { profile } = useAuth();
  const { settings } = useConfig();
  const { needsChoice, setLanguage } = useLanguage();
  const [saving, setSaving] = useState('');

  if (!needsChoice || isTermsPending(profile, settings)) return null;

  const choose = async (value) => {
    setSaving(value);
    const result = await setLanguage(value);
    setSaving('');
    if (!result.success) toast.error('Could not save your language. Try again.');
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="language-gate-title" translate="no" style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div className="ui-root" style={{ width: '100%', maxWidth: '420px', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-lg)', boxShadow: '0 20px 45px rgba(0,0,0,0.45)', padding: '1.5rem', display: 'grid', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <Languages size={20} color="var(--admin-brand)" />
          <h3 id="language-gate-title" style={{ margin: 0, color: 'var(--admin-text-primary)', fontSize: '1rem', fontWeight: 950 }}>Choose your language / Piliin ang wika</h3>
        </div>
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--admin-text-secondary)', fontWeight: 600 }}>You can change this any time in Settings. / Maaari mo itong baguhin anumang oras sa Settings.</p>
        <div style={{ display: 'grid', gap: '0.6rem' }}>
          {LANGUAGES.map((lang) => (
            <Button key={lang.value} type="button" size="lg" variant={lang.value === 'en' ? 'default' : 'outline'} disabled={Boolean(saving)} onClick={() => choose(lang.value)}>
              {saving === lang.value ? '…' : lang.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default LanguageGate;
