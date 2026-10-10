import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { startTranslating, stopTranslating } from '../i18n/translator';

/**
 * The language of the signed-in account (English "en" or Filipino/Tagalog "tl"). It is kept on the account
 * (profiles.language) so it follows the person to any device, and in this browser so the login and landing
 * pages already use it. An account that has never chosen (language is empty) is asked once, after the terms.
 * Translation itself is done by i18n/translator.js from the catalog; the components stay in English.
 */
export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'tl', label: 'Filipino (Tagalog)' }
];

const STORAGE_KEY = 'comar.language';
const readStored = () => {
  try { return localStorage.getItem(STORAGE_KEY) === 'tl' ? 'tl' : 'en'; } catch { return 'en'; }
};
const CATALOGS = { tl: () => import('../i18n/tl.json') };

const LanguageContext = createContext({ language: 'en', setLanguage: async () => ({ success: false }), needsChoice: false });
export const useLanguage = () => useContext(LanguageContext);

export const LanguageProvider = ({ children }) => {
  const { profile, fetchProfile } = useAuth();
  const [language, setLanguageState] = useState(readStored);

  // the account's own choice wins once it is known
  useEffect(() => {
    if (profile?.language === 'en' || profile?.language === 'tl') {
      setLanguageState(profile.language);
      try { localStorage.setItem(STORAGE_KEY, profile.language); } catch { /* private mode */ }
    }
  }, [profile?.language]);

  useEffect(() => {
    document.documentElement.lang = language === 'tl' ? 'fil' : 'en';
    if (language === 'en') { stopTranslating(); return undefined; }
    let cancelled = false;
    CATALOGS[language]().then((module) => { if (!cancelled) startTranslating(module.default || module); });
    return () => { cancelled = true; stopTranslating(); };
  }, [language]);

  const setLanguage = useCallback(async (next) => {
    if (next !== 'en' && next !== 'tl') return { success: false };
    setLanguageState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
    if (!profile?.id) return { success: true, saved: false };
    const { error } = await supabase.rpc('set_my_language', { p_language: next });
    if (error) return { success: false, error };
    await fetchProfile?.(profile.id, 'LANGUAGE_CHANGED', true);
    return { success: true, saved: true };
  }, [profile?.id, fetchProfile]);

  const needsChoice = Boolean(profile?.id && !profile.language);
  const value = useMemo(() => ({ language, setLanguage, needsChoice }), [language, setLanguage, needsChoice]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};
