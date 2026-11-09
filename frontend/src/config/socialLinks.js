/** Social media pages the admin links in the Business Hub; shown as icons in the public site's footer. */
export const SOCIAL_PLATFORMS = [
  { id: 'facebook', label: 'Facebook', hosts: ['facebook.com', 'fb.com', 'fb.me'] },
  { id: 'instagram', label: 'Instagram', hosts: ['instagram.com'] },
  { id: 'tiktok', label: 'TikTok', hosts: ['tiktok.com'] },
  { id: 'youtube', label: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  { id: 'x', label: 'X (Twitter)', hosts: ['x.com', 'twitter.com'] },
  { id: 'messenger', label: 'Messenger', hosts: ['m.me', 'messenger.com'] },
];
const byId = Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p.id, p]));

/** The full https link, or null when it is not a page on that platform's site. */
export const toSocialUrl = (platform, raw) => {
  const p = byId[platform];
  const text = String(raw || '').trim();
  if (!p || !text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const host = url.hostname.toLowerCase();
    return p.hosts.some((h) => host === h || host.endsWith(`.${h}`)) ? `https://${url.host}${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
};

/** Valid links only, one per platform, in the platform list's order. */
export const cleanSocialLinks = (links) => SOCIAL_PLATFORMS
  .map((p) => {
    const row = (Array.isArray(links) ? links : []).find((l) => l?.platform === p.id);
    const url = row && toSocialUrl(p.id, row.url);
    return url ? { platform: p.id, label: p.label, url } : null;
  })
  .filter(Boolean);
