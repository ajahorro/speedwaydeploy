import React, { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import toast from '@/lib/toast';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { COMMUNICATION_PREFERENCES } from '../../config/legalContent';
import { loadPreferences, savePreferences } from '../../utils/preferenceStore';
import { playJobAssignmentChime } from '../../utils/jobAssignmentChime';
import { SettingsSection, SettingRow, ToggleSwitch, SegmentedControl } from './SettingsPrimitives';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { LANGUAGES, useLanguage } from '../../context/LanguageContext';

/**
 * APP PREFERENCES (Directive §2).
 * Flat, line-divided rows: interface theme + communication toggles.
 * `role` restricts which toggles appear (admins get theme only). Persistence is
 * offline-safe via preferenceStore (localStorage authoritative, DB best-effort).
 */

const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark Mode', icon: Moon },
  { value: 'light', label: 'Light Mode', icon: Sun },
  { value: 'system', label: 'System Default', icon: Monitor },
];

const AppPreferencesCard = ({ role = 'customer' }) => {
  const { theme, resolvedTheme, toggleTheme } = useTheme();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const { user, profile } = useAuth();
  const userId = user?.id || profile?.id;
  const { language, setLanguage } = useLanguage();

  const [prefs, setPrefs] = useState(() =>
    COMMUNICATION_PREFERENCES.reduce((acc, p) => ({ ...acc, [p.key]: p.defaultValue }), {})
  );
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const loaded = await loadPreferences(userId);
      if (mounted) {
        setPrefs(loaded);
        setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [userId]);

  const isAdmin = role === 'admin';
  const themeOptions = isMobile
    ? THEME_OPTIONS.filter((option) => option.value !== 'system')
    : THEME_OPTIONS;
  const selectedTheme = isMobile && theme === 'system' ? resolvedTheme : theme;
  // Staff get only the implemented assignment chime. Admin communications are system-wide.
  const visiblePrefs = isAdmin
    ? []
    : role === 'staff'
      ? [{ key: 'soundHapticChime', label: 'Assignment chime', description: 'Play a short tone and vibrate when a new vehicle is assigned.', defaultValue: false }]
      : COMMUNICATION_PREFERENCES.filter((pref) => !pref.roles || pref.roles.includes(role));

  const handleToggle = async (key) => {
    if (savingKey) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next); // optimistic
    setSavingKey(key);
    if (key === 'soundHapticChime' && next[key]) playJobAssignmentChime();
    const result = await savePreferences(userId, next);
    setSavingKey(null);
    if (!result.success) {
      setPrefs(prefs); // rollback on hard failure
      toast.error('Failed to save preference.');
      return;
    }
    const label = visiblePrefs.find((p) => p.key === key)?.label || 'Preference';
    toast.success(`${label} ${next[key] ? 'enabled' : 'disabled'}`);
    if (result.persisted === false) {
      // Saved locally but not synced to the account (schema/offline). Non-fatal.
      toast('Saved on this device. Account sync unavailable.', { icon: 'ℹ️' });
    }
  };

  return (
    <SettingsSection title="App Preferences">
      <SettingRow
        title="Interface Theme"
        subtitle={isAdmin
          ? 'Personal appearance for your admin account.'
          : isMobile ? 'Choose light or dark appearance.' : 'Choose system, light, or dark appearance.'}
      >
        <SegmentedControl
          options={themeOptions}
          value={selectedTheme}
          onChange={toggleTheme}
          ariaLabel="Interface theme"
        />
      </SettingRow>

      <SettingRow title="Language" subtitle="Choose English or Filipino (Tagalog) for the whole app.">
        <SegmentedControl
          options={LANGUAGES}
          value={language}
          onChange={async (next) => { const result = await setLanguage(next); if (!result.success) toast.error('Could not save your language.'); }}
          ariaLabel="Language"
        />
      </SettingRow>

      {visiblePrefs.map((pref) => (
        <SettingRow key={pref.key} title={pref.label} subtitle={pref.description}>
          <ToggleSwitch
            checked={Boolean(prefs[pref.key])}
            loading={savingKey === pref.key}
            disabled={loading}
            label={pref.label}
            onChange={() => handleToggle(pref.key)}
          />
        </SettingRow>
      ))}
    </SettingsSection>
  );
};

export default AppPreferencesCard;