import React, { createContext, useContext, useState, useEffect, useLayoutEffect, useRef } from 'react';

const ThemeContext = createContext();

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(() => localStorage.getItem('comar-theme') || localStorage.getItem('speedway-theme') || 'system');
  const [systemTheme, setSystemTheme] = useState(() => (
    window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  ));

  useEffect(() => {
    localStorage.setItem('comar-theme', theme);
  }, [theme]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleSystemThemeChange = (event) => setSystemTheme(event.matches ? 'light' : 'dark');
    mediaQuery.addEventListener('change', handleSystemThemeChange);
    return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
  }, []);

  const toggleTheme = (nextTheme) => {
    setTheme(nextTheme || (prev => prev === 'light' ? 'dark' : 'light'));
  };

  const resolvedTheme = theme === 'system' ? systemTheme : theme;

  // UIProvider renders global overlays outside each account layout. Apply the
  // resolved preference at the document level so those overlays (including
  // logout confirmation) follow light, dark, and system themes too.
  //
  // Every element has its own colour transition (index.css and many inline styles, each with its own timing), so
  // changing the theme used to fade the page piece by piece. For the moment of the change all transitions are
  // switched off (class theme-switching), so the whole page changes in one go, and they come back two frames later.
  const firstApply = useRef(true);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!firstApply.current) root.classList.add('theme-switching');
    firstApply.current = false;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => root.classList.remove('theme-switching')); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [resolvedTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);
