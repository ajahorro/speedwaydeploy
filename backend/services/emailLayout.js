/**
 * ONE look for every email Comar Garage sends.
 *
 * Kept in step with supabase/functions/_shared/emailLayout.ts (the booking, status, reminder and refund emails
 * are sent from Supabase Edge Functions). scripts/verify-email-layout.mjs renders the same sample through both
 * and fails if they differ, so change both files together.
 *
 * Why it looks the way it does (the "does this look like phishing?" checklist):
 *   - the real logo and shop name in a dark header, the same on every email;
 *   - one clear action, with the website it opens written under the button, so people can see it is ours;
 *   - a footer that says we never ask for passwords, PINs or codes, who sent it (no-reply) and where replies go;
 *   - the shop's address, and why the person got the email (with an unsubscribe link for promos);
 *   - table layout and inline styles only, so Gmail, Outlook and phone apps all draw it the same;
 *   - a plain-text version built from the same content (spam filters score HTML-only mail down).
 *
 * Callers pass PLAIN TEXT. Everything is escaped here; **double asterisks** mark bold words.
 */

const BRAND = '#C41F2B';
const INK = '#18181b';
const MUTED = '#5f5b57';
const LINE = '#e7e4e0';
const SOFT = '#f6f5f3';
const PAGE = '#efeeec';
const HEADER = '#111214';
const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const TZ = 'Asia/Manila';

const DEFAULT_SHOP = Object.freeze({
  name: 'Comar Garage',
  address: '39 Hunters ROTC, Barangay San Juan, Cainta, 1900 Rizal',
  site: 'https://comargarage.com',
  phone: '',
  email: '',
});

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

/** escape, then turn **bold** into <strong> and line breaks into <br> */
const rich = (value) => escapeHtml(value)
  .replace(/\*\*(.+?)\*\*/g, '<strong style="color:' + INK + ';">$1</strong>')
  .replace(/\n/g, '<br>');
const plain = (value) => String(value ?? '').replace(/\*\*(.+?)\*\*/g, '$1');

/** Dates and times always in Philippine time, written the way people say them. */
const formatDateTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-PH', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
};
const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-PH', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(date);
};
const formatPeso = (value) => {
  const n = Number(value);
  return `₱${(Number.isFinite(n) ? n : 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const hostOf = (url) => {
  try { const u = new URL(url); return `${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { return ''; }
};

const TONES = {
  info: { bg: '#f1f5f9', border: '#dbe3ea', ink: '#1f2a37' },
  success: { bg: '#ecfdf3', border: '#bfe8cf', ink: '#14532d' },
  warn: { bg: '#fff7e8', border: '#f3d9a4', ink: '#7a4a00' },
  danger: { bg: '#fdf0f0', border: '#f2c9cb', ink: '#8a1820' },
};

// ── blocks ───────────────────────────────────────────────────────────────────

const rowsHtml = (block) => {
  const rows = (block.rows || []).filter((r) => r && r[1] !== undefined && r[1] !== null && String(r[1]) !== '');
  if (!rows.length) return '';
  const title = block.title ? `<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">${escapeHtml(block.title)}</p>` : '';
  const trs = rows.map(([label, value, opts = {}], i) => {
    const last = i === rows.length - 1;
    const border = last ? '' : `border-bottom:1px solid ${LINE};`;
    const weight = opts.strong ? '700' : '600';
    const color = opts.brand ? BRAND : INK;
    const size = opts.strong ? '16px' : '14px';
    return `<tr><td style="padding:11px 14px;${border}font-size:14px;color:${MUTED};vertical-align:top;">${escapeHtml(label)}</td><td align="right" style="padding:11px 14px;${border}font-size:${size};font-weight:${weight};color:${color};text-align:right;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td></tr>`;
  }).join('');
  return `${title}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border:1px solid ${LINE};border-radius:4px;background:${SOFT};margin:0 0 20px;">${trs}</table>`;
};

const codeHtml = (block) => `
  <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">${escapeHtml(block.label || 'Your code')}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px;"><tr><td style="padding:14px 22px;background:${SOFT};border:1px solid ${LINE};border-radius:4px;font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:700;letter-spacing:8px;color:${INK};">${escapeHtml(block.code)}</td></tr></table>
  ${block.note ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:${MUTED};">${rich(block.note)}</p>` : ''}`;

const noticeHtml = (block) => {
  const t = TONES[block.tone] || TONES.info;
  const title = block.title ? `<strong style="display:block;margin:0 0 4px;color:${t.ink};">${escapeHtml(block.title)}</strong>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:0 0 20px;"><tr><td style="padding:12px 14px;background:${t.bg};border:1px solid ${t.border};border-radius:4px;font-size:14px;line-height:1.6;color:${t.ink};">${title}${rich(block.text)}</td></tr></table>`;
};

const quoteHtml = (block) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:0 0 20px;"><tr><td style="padding:14px 16px;background:${SOFT};border:1px solid ${LINE};border-radius:4px;font-size:15px;line-height:1.65;color:${INK};white-space:pre-wrap;">${escapeHtml(block.text)}</td></tr></table>`;

/** the booking's progress: Booked, Confirmed, In progress, Ready, Released */
const STEPS = ['Booked', 'Confirmed', 'In progress', 'Ready', 'Released'];
const stepsHtml = (block) => {
  const active = Number.isInteger(block.active) ? block.active : -1;
  const cells = STEPS.map((label, i) => {
    const done = active >= 0 && i <= active;
    const dot = done ? BRAND : '#d4d0cb';
    const weight = i === active ? '700' : '400';
    const color = i === active ? INK : MUTED;
    return `<td width="20%" align="center" style="vertical-align:top;padding:0 2px;"><div style="width:12px;height:12px;line-height:12px;border-radius:6px;background:${dot};margin:0 auto 6px;font-size:1px;">&nbsp;</div><div style="font-size:11px;line-height:14px;color:${color};font-weight:${weight};">${escapeHtml(label)}</div></td>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr>${cells}</tr></table>`;
};

const paragraphHtml = (text) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${INK};">${rich(text)}</p>`;

const blockHtml = (block) => {
  if (typeof block === 'string') return paragraphHtml(block);
  switch (block?.type) {
    case 'rows': return rowsHtml(block);
    case 'code': return codeHtml(block);
    case 'notice': return noticeHtml(block);
    case 'quote': return quoteHtml(block);
    case 'steps': return stepsHtml(block);
    case 'small': return `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:${MUTED};">${rich(block.text)}</p>`;
    default: return '';
  }
};

const blockText = (block) => {
  if (typeof block === 'string') return plain(block);
  switch (block?.type) {
    case 'rows': {
      const rows = (block.rows || []).filter((r) => r && r[1] !== undefined && r[1] !== null && String(r[1]) !== '');
      if (!rows.length) return '';
      return `${block.title ? `${block.title.toUpperCase()}\n` : ''}${rows.map(([l, v]) => `${l}: ${v}`).join('\n')}`;
    }
    case 'code': return `${block.label || 'Your code'}: ${block.code}${block.note ? `\n${plain(block.note)}` : ''}`;
    case 'notice': return `${block.title ? `${block.title}: ` : ''}${plain(block.text)}`;
    case 'quote': return String(block.text || '');
    case 'steps': return Number.isInteger(block.active) && block.active >= 0 ? `Progress: ${STEPS[block.active]}` : '';
    case 'small': return plain(block.text);
    default: return '';
  }
};

// ── the email ────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.title            the heading (also the browser/preview title)
 * @param {string} [o.preheader]      the grey line inbox apps show after the subject
 * @param {string} [o.greeting]       "Hi Juan,"
 * @param {Array}  o.blocks           paragraphs (strings) and blocks ({type:'rows'|'code'|'notice'|'quote'|'steps'|'small'})
 * @param {{label:string,url:string}} [o.cta]   one button
 * @param {string} [o.reason]         why they got this email
 * @param {string} [o.unsubscribeUrl] promos only
 * @param {string} [o.replyNote]      overrides the "reply" sentence in the footer
 * @param {object} [o.shop]           { name, address, site, phone, email }
 * @returns {{ html: string, text: string }}
 */
const renderEmail = (o) => {
  const shop = { ...DEFAULT_SHOP, ...Object.fromEntries(Object.entries(o.shop || {}).filter(([, v]) => v)) };
  const site = String(shop.site || DEFAULT_SHOP.site).replace(/\/$/, '');
  const siteHost = hostOf(site) || 'comargarage.com';
  const blocks = (o.blocks || []).filter(Boolean);
  const replyNote = o.replyNote !== undefined
    ? o.replyNote
    : shop.email ? `This email was sent automatically. To reach us, reply to this email or write to ${shop.email}.` : 'This email was sent automatically from a no-reply address.';

  const cta = o.cta && o.cta.url ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 8px;"><tr><td style="border-radius:2px;background:${BRAND};">
      <a href="${escapeHtml(o.cta.url)}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:2px;">${escapeHtml(o.cta.label)}</a>
    </td></tr></table>
    <p style="margin:0 0 20px;font-size:12px;line-height:1.5;color:${MUTED};">This button opens <span style="color:${INK};">${escapeHtml(hostOf(o.cta.url) || siteHost)}</span></p>` : '';

  const footerLines = [
    `<strong style="color:${INK};">${escapeHtml(shop.name)}</strong> · ${escapeHtml(shop.address)}`,
    [shop.phone, shop.email, siteHost].filter(Boolean).map(escapeHtml).join(' · '),
  ].filter(Boolean);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(o.title)}</title></head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE};font-size:1px;line-height:1px;">${escapeHtml(o.preheader || '')}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:4px;font-family:${FONT};">
    <tr><td style="background:${HEADER};padding:18px 24px;border-radius:4px 4px 0 0;">
      <a href="${escapeHtml(site)}" style="text-decoration:none;"><img src="${escapeHtml(site)}/email/logo-dark-bg.png" width="140" height="46" alt="${escapeHtml(shop.name)}" style="display:block;border:0;width:140px;height:auto;color:#ffffff;font-size:18px;font-weight:700;"></a>
    </td></tr>
    <tr><td style="padding:28px 24px 8px;">
      <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(o.title)}</h1>
      ${o.greeting ? paragraphHtml(o.greeting) : ''}
      ${blocks.map(blockHtml).join('\n')}
      ${cta}
    </td></tr>
    <tr><td style="padding:0 24px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};"><tr><td style="padding-top:16px;font-size:12px;line-height:1.6;color:${MUTED};">
        <p style="margin:0 0 10px;"><strong style="color:${INK};">Stay safe:</strong> ${escapeHtml(shop.name)} will never ask for your password, PIN or one-time code by email, chat or phone. Our links only go to ${escapeHtml(siteHost)}.</p>
        <p style="margin:0 0 10px;">${escapeHtml(replyNote)}</p>
        ${o.reason ? `<p style="margin:0 0 10px;">${escapeHtml(o.reason)}${o.unsubscribeUrl ? ` <a href="${escapeHtml(o.unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a>` : ''}</p>` : ''}
        <p style="margin:0;">${footerLines.join('<br>')}</p>
      </td></tr></table>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const textParts = [
    shop.name.toUpperCase(),
    '',
    o.title,
    '',
    o.greeting ? plain(o.greeting) : null,
    ...blocks.map(blockText).filter(Boolean).flatMap((t) => [t, '']),
    o.cta && o.cta.url ? `${o.cta.label}: ${o.cta.url}\n` : null,
    '--',
    `Stay safe: ${shop.name} will never ask for your password, PIN or one-time code. Our links only go to ${siteHost}.`,
    replyNote,
    o.reason ? `${o.reason}${o.unsubscribeUrl ? ` Unsubscribe: ${o.unsubscribeUrl}` : ''}` : null,
    `${shop.name}, ${shop.address}`,
  ].filter((line) => line !== null && line !== undefined);
  const text = textParts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  return { html, text };
};

module.exports = { renderEmail, escapeHtml, formatDateTime, formatDate, formatPeso, DEFAULT_SHOP, STEPS };
