import React, { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { COMMUNICATION_PREFERENCES } from '../../config/legalContent';
import { loadPreferences, savePreferences } from '../../utils/preferenceStore';
import { SettingsSection, SettingRow, ToggleSwitch, SegmentedControl } from './SettingsPrimitives';

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
  const { theme, toggleTheme } = useTheme();
  const { user, profile } = useAuth();
  const userId = user?.id || profile?.id;

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
  // Admin settings show ONLY the interface theme. Email/SMS communication
  // toggles belong to the customer/staff experience; admins manage system-wide
  // communications from the notification tools, not personal preferences.
  const visiblePrefs = isAdmin ? [] : COMMUNICATION_PREFERENCES.filter((p) => !p.roles || p.roles.includes(role));

  const handleToggle = async (key) => {
    if (savingKey) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next); // optimistic
    setSavingKey(key);
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
        subtitle={isAdmin ? 'Personal appearance for your admin account.' : 'Choose system, light, or dark appearance.'}
      >
        <SegmentedControl
          options={THEME_OPTIONS}
          value={theme}
          onChange={toggleTheme}
          ariaLabel="Interface theme"
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