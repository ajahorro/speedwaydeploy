// Refuses a password found in known data breaches (Have I Been Pwned). Only the first 5 characters of its SHA-1
// hash leave the browser. If the service cannot be reached the password is allowed.
export const BREACHED_PASSWORD_ERROR = 'This password has appeared in a data breach and is not safe to use. Please choose a different one.';

export const isBreachedPassword = async (password) => {
  try {
    const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(password)));
    const hash = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    return (await res.text()).split('\n').some((line) => { const [suffix, count] = line.trim().split(':'); return suffix === hash.slice(5) && Number(count) > 0; });
  } catch {
    return false;
  }
};
