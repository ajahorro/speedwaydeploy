import { useEffect, useState } from 'react';
import { BACKEND_URL, authHeaders } from '../config/api';

// Receipts and chat attachments are private: the stored address is swapped for a link that works for one hour,
// and only for people allowed to see the file (the server decides).
const cache = new Map(); // stored value -> { url, until }

export async function signFiles(values) {
  const wanted = [...new Set(values.filter(Boolean).map(String))];
  const missing = wanted.filter((v) => !(cache.get(v)?.until > Date.now()));
  if (missing.length) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/files/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ files: missing }),
      });
      const { urls = {} } = await res.json().catch(() => ({}));
      Object.entries(urls).forEach(([v, url]) => cache.set(v, { url, until: Date.now() + 50 * 60000 }));
    } catch { /* the file simply does not show */ }
  }
  return new Map(wanted.map((v) => [v, cache.get(v)?.url || null]));
}

/** Replaces the given file fields on each row with a working link (null when it may not be opened). */
export async function signRows(rows, fields = ['receipt_url']) {
  const links = await signFiles(rows.flatMap((r) => fields.map((f) => r[f])));
  return rows.map((r) => ({ ...r, ...Object.fromEntries(fields.map((f) => [f, r[f] ? links.get(String(r[f])) : r[f]])) }));
}

/** One file link for rendering; null until it is ready. */
export function useSignedUrl(value) {
  const [url, setUrl] = useState(() => (value && cache.get(String(value))?.until > Date.now() ? cache.get(String(value)).url : null));
  useEffect(() => {
    let live = true;
    if (!value || String(value).startsWith('blob:')) { setUrl(value || null); return undefined; }
    signFiles([value]).then((m) => { if (live) setUrl(m.get(String(value))); });
    return () => { live = false; };
  }, [value]);
  return url;
}
