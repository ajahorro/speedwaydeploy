import { useEffect, useRef } from 'react';

// Cloudflare Turnstile bot check. Off until VITE_TURNSTILE_SITE_KEY is set; then sign-in and sign-up send its token
// to Supabase (which checks it once captcha is turned on under Authentication > Attack Protection).
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;
export const captchaEnabled = Boolean(SITE_KEY);

let loader;
const loadScript = () => loader || (loader = new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement('script'), { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', async: true, onload: resolve, onerror: reject });
  document.head.appendChild(s);
}));

/** Renders the check and reports its token; a new resetKey gives a fresh check (each token works once). */
export default function Turnstile({ onToken, resetKey = 0 }) {
  const box = useRef(null);
  useEffect(() => {
    if (!SITE_KEY) return undefined;
    let id;
    let gone = false;
    loadScript().then(() => {
      if (gone || !box.current) return;
      id = window.turnstile.render(box.current, {
        sitekey: SITE_KEY, theme: 'auto', size: 'flexible',
        callback: onToken, 'expired-callback': () => onToken(''), 'error-callback': () => onToken(''),
      });
    }).catch(() => onToken(''));
    return () => { gone = true; if (id !== undefined) window.turnstile?.remove(id); onToken(''); };
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return SITE_KEY ? <div ref={box} className="mt-4 w-full" /> : null;
}
