const { Resend } = require('resend');
const { renderEmail, formatDateTime, DEFAULT_SHOP } = require('./emailLayout');
const { appUrl } = require('./appUrl');

/**
 * Every email the backend sends goes through here, in the one shared layout (./emailLayout.js).
 *
 * Sender: always the no-reply address on our verified domain (EMAIL_FROM to change it). Replies go to the shop's
 * own inbox (Business Hub › Business Profile email) through Reply-To, so a customer who answers still reaches
 * a person. Every message carries a plain-text version.
 */
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const SENDER = process.env.EMAIL_FROM || 'Comar Garage <noreply@comargarage.com>';

// ── shop details for the footer (name, address, phone, email), read from the Business Hub ──────────────────────
let shopProvider = null;
let shopCache = { at: 0, value: null };
/** server.js hands us a function that reads business_config; cached for five minutes. */
const configureShop = (fn) => { shopProvider = fn; shopCache = { at: 0, value: null }; };
const getShop = async () => {
  if (shopCache.value && Date.now() - shopCache.at < 5 * 60 * 1000) return shopCache.value;
  let value = { ...DEFAULT_SHOP, site: appUrl('/').replace(/\/$/, '') };
  try {
    const row = shopProvider ? await shopProvider() : null;
    if (row) {
      value = {
        ...value,
        name: row.business_name ? titleCase(row.business_name) : value.name,
        address: row.business_address || value.address,
        phone: row.contact_number || '',
        email: row.email_address || '',
      };
    }
  } catch { /* footer falls back to the defaults */ }
  shopCache = { at: Date.now(), value };
  return value;
};
const titleCase = (s) => String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

const send = async ({ to, subject, html, text, replyTo, headers, attachments }) => {
  if (!resend) return { success: false, error: 'RESEND_API_KEY is not configured' };
  try {
    const shop = await getShop();
    const reply = replyTo === null ? undefined : (replyTo || shop.email || undefined);
    console.log(`[Email] Sending "${subject}"`);
    const { data, error } = await resend.emails.send({
      from: SENDER,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(text ? { text } : {}),
      ...(reply ? { reply_to: reply } : {}),
      ...(headers ? { headers } : {}),
      ...(attachments?.length ? { attachments } : {})
    });
    if (error) {
      const detail = error.statusCode === 401 || /invalid.*api.?key/i.test(error.message || '')
        ? 'RESEND_API_KEY is invalid or expired.'
        : (error.message || JSON.stringify(error));
      console.error(`[Email] Resend rejected message: ${detail}`);
      return { success: false, error: detail };
    }
    return { success: true, data };
  } catch (error) {
    console.error('[EmailService] Delivery failed:', error.message);
    return { success: false, error: error.message };
  }
};

/** render with the shop's footer details, then send */
const deliver = async ({ to, subject, replyTo, headers, attachments, ...layout }) => {
  const shop = await getShop();
  const { html, text } = renderEmail({ ...layout, shop });
  return send({ to, subject, html, text, replyTo, headers, attachments });
};

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const hi = (name) => (firstName(name) ? `Hi ${firstName(name)},` : 'Hi,');

// ── Account and security ──────────────────────────────────────────────────────────────────────────────────────

/** "Forgot password" and "Change password" links (single use, short-lived). */
const sendPasswordConfirmationEmail = ({ email, url, purpose, minutes = 15 }) => deliver({
  to: email,
  subject: purpose === 'RESET' ? 'Reset your Comar Garage password' : 'Confirm your new Comar Garage password',
  preheader: `This link works once and expires in ${minutes} minutes.`,
  title: purpose === 'RESET' ? 'Reset your password' : 'Confirm your password change',
  greeting: 'Hi,',
  blocks: [
    purpose === 'RESET'
      ? `Someone asked to reset the password for the Comar Garage account **${email}**. If that was you, set a new password with the button below.`
      : `You asked to change the password for the Comar Garage account **${email}**. Confirm it with the button below and the new password takes effect.`,
    { type: 'small', text: `The link works once and expires in ${minutes} minutes.` },
    { type: 'notice', tone: 'info', text: 'If you did not ask for this, you can ignore this email. Your password stays the same.' },
  ],
  cta: { label: purpose === 'RESET' ? 'Set a new password' : 'Confirm password change', url },
  reason: 'You get this email because someone asked to change the password on this account.',
});

const sendPasswordChangedEmail = ({ email, purpose }) => deliver({
  to: email,
  subject: 'Your Comar Garage password was changed',
  preheader: 'If this was not you, reset your password now.',
  title: 'Your password was changed',
  greeting: 'Hi,',
  blocks: [
    `The password for **${email}** was ${purpose === 'RESET' ? 'reset' : 'changed'} on ${formatDateTime(new Date())}.`,
    { type: 'notice', tone: 'warn', title: 'Not you?', text: 'Open the sign-in page, choose **Forgot password** and set a new one straight away. Then tell us by replying to this email.' },
  ],
  cta: { label: 'Go to sign in', url: appUrl('/login') },
  reason: 'You get this email whenever the password on your account changes.',
});

const sendWrongPasswordSecurityNotice = ({ email, attempts, lockedUntil, resetLink }) => deliver({
  to: email,
  subject: 'Sign-in to your Comar Garage account is paused',
  preheader: 'Too many wrong passwords. Reset your password to sign in now.',
  title: 'We paused sign-in to keep your account safe',
  greeting: 'Hi,',
  blocks: [
    `The wrong password was entered for **${email}** too many times in a row, so we paused sign-in for a while.`,
    { type: 'rows', rows: [['Wrong attempts', String(attempts ?? '')], ['Paused until', lockedUntil ? formatDateTime(lockedUntil) : 'about an hour after the last try']] },
    '**If it was you:** reset your password with the button below and you can sign in right away.',
    '**If it was not you:** someone may be guessing your password. Your account stays paused, but we recommend setting a new password now.',
  ],
  cta: resetLink ? { label: 'Reset my password', url: resetLink } : null,
  reason: 'You get this email when sign-in to your account is paused for safety.',
});

const sendEmergencyRecoveryEmail = ({ recipientEmail, otp }) => deliver({
  to: recipientEmail,
  subject: 'Your Comar Garage unlock code',
  preheader: 'Use it within 15 minutes. Never share it with anyone.',
  title: 'Your unlock code',
  greeting: 'Hi,',
  blocks: [
    `Someone asked to unlock the Comar Garage account **${recipientEmail}**. Enter this code on the sign-in page to unlock it and set a new password.`,
    { type: 'code', label: 'Unlock code', code: otp, note: 'It works once and expires in **15 minutes**.' },
    { type: 'notice', tone: 'warn', text: 'Never share this code. Comar Garage staff will never ask you for it. If you did not ask for it, ignore this email and your account stays locked.' },
  ],
  reason: 'You get this email because someone asked to unlock this account.',
});

const sendEmailChangeCode = ({ oldEmail, newEmail, otp }) => deliver({
  to: oldEmail,
  subject: 'Your code to change your Comar Garage email',
  preheader: 'Use it within 15 minutes. Never share it with anyone.',
  title: 'Confirm your new email address',
  greeting: 'Hi,',
  blocks: [
    `You asked to change your account email from **${oldEmail}** to **${newEmail}**. Enter this code in the app to confirm.`,
    { type: 'code', label: 'Confirmation code', code: otp, note: 'It works once and expires in **15 minutes**.' },
    { type: 'notice', tone: 'warn', title: 'Not you?', text: 'Do not share the code. Change your password now so no one else can change your email.' },
  ],
  reason: 'You get this email because someone asked to change the email on this account.',
});

const ROLE_WORD = { STAFF: 'staff', ADMIN: 'administrator', SUPER_ADMIN: 'administrator', CUSTOMER: 'customer' };

/** New staff or administrator: a link to set their own password. No password is ever sent by email. */
const sendInviteAccountEmail = ({ recipientEmail, firstName: first, role, setPasswordUrl, expiresAt }) => deliver({
  to: recipientEmail,
  subject: `You're invited to the Comar Garage ${ROLE_WORD[String(role).toUpperCase()] || 'team'} portal`,
  preheader: 'Set your password to finish setting up your account.',
  title: 'Set up your Comar Garage account',
  greeting: first ? `Hi ${first},` : 'Hi,',
  blocks: [
    `An administrator created a **${ROLE_WORD[String(role).toUpperCase()] || 'team'}** account for you. Choose your own password to finish setting it up.`,
    { type: 'rows', rows: [['Your sign-in email', recipientEmail], ['Link expires', expiresAt ? formatDateTime(expiresAt) : 'in 48 hours']] },
    { type: 'small', text: 'The link works once. If it expires, ask an administrator to send a new invitation.' },
  ],
  cta: { label: 'Set my password', url: setPasswordUrl },
  reason: 'You get this email because an administrator at Comar Garage invited you. If you do not work with Comar Garage, ignore it.',
});

const sendQrChangeOtpEmail = ({ recipientEmail, otp, requestedAt, requestIp }) => deliver({
  to: recipientEmail,
  subject: 'Your code to approve the payment QR change',
  preheader: 'Use it within 5 minutes. Never share it with anyone.',
  title: 'Confirm the payment QR change',
  greeting: 'Hi,',
  blocks: [
    'Someone asked to change the **QR payment details** customers pay to in the Business Hub. Enter this code to approve it.',
    { type: 'code', label: 'Approval code', code: otp, note: 'It works once and expires in **5 minutes**.' },
    { type: 'rows', title: 'Request details', rows: [['Requested', formatDateTime(requestedAt || new Date())], ['Account', recipientEmail], ['Network address', requestIp || 'Not available']] },
    { type: 'notice', tone: 'danger', title: 'Not you?', text: 'Do not share the code. Someone may be trying to redirect customer payments. Change your password now.' },
  ],
  reason: 'You get this email because payment details can only change with an administrator\'s approval.',
});

// ── Messages ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Admin announcement to every account. The message is plain text. */
const sendAnnouncementEmail = ({ to, name, message }) => deliver({
  to,
  subject: `News from Comar Garage: ${String(message).trim().split(/\s+/).slice(0, 8).join(' ')}${String(message).trim().split(/\s+/).length > 8 ? '…' : ''}`,
  preheader: String(message).trim().slice(0, 120),
  title: 'A message from Comar Garage',
  greeting: hi(name),
  blocks: [{ type: 'quote', text: String(message).trim() }],
  cta: { label: 'Open Comar Garage', url: appUrl('/login') },
  reason: 'You get this email because you have a Comar Garage account.',
});

const sendPromoEmail = ({ to, name, promoName, discount, services, vehicles, validity, unsubscribeUrl }) => deliver({
  to,
  subject: `${promoName}: ${discount} at Comar Garage`,
  preheader: `${discount}${services.length ? ` on ${services.slice(0, 2).join(', ')}` : ''}${validity ? `. Valid ${validity}.` : ''}`,
  title: promoName,
  greeting: hi(name),
  blocks: [
    `There's a new promo for your **${vehicles.join(', ')}**.`,
    { type: 'rows', rows: [['Discount', discount, { strong: true, brand: true }], ['Services', services.join(', ')], ['Valid', validity]] },
    'Choose one of these services when you book and the discount is applied automatically. No code needed.',
  ],
  cta: { label: 'Book now', url: appUrl('/customer/book') },
  reason: 'You get this email because “Be the first to know about new promos” is on in your settings.',
  unsubscribeUrl,
  headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
});

const sendInquiryReplyEmail = ({ to, name, body, replyTo }) => deliver({
  to,
  replyTo,
  subject: 'Re: your message to Comar Garage',
  preheader: String(body).trim().slice(0, 120),
  title: 'We answered your message',
  greeting: hi(name),
  blocks: [{ type: 'quote', text: body }],
  replyNote: 'Reply to this email to keep the conversation going. It reaches the shop directly.',
  cta: { label: 'Create a free account', url: appUrl('/login') },
  reason: 'You get this email because you sent us a message from comargarage.com. With an account you can book online and chat with us in the app.',
});

const sendInquiryToShopEmail = ({ to, name, email, message, conversationUrl }) => deliver({
  to,
  replyTo: email,
  subject: `Website message from ${name}`,
  preheader: String(message).trim().slice(0, 120),
  title: 'New message from the website',
  blocks: [
    { type: 'rows', rows: [['From', name], ['Email', email]] },
    { type: 'quote', text: message },
    'Answer it in Message Inquiries. Your reply is emailed to them.',
  ],
  cta: conversationUrl ? { label: 'Open the conversation', url: conversationUrl } : null,
  replyNote: 'Replying to this email writes straight to the sender, outside the app.',
  reason: 'Sent to the shop inbox when someone writes from the website.',
});

const sendSupportReportEmail = ({ to, kindLabel, who, role, email, page, profileId, message }) => deliver({
  to,
  replyTo: email || undefined,
  subject: `${kindLabel} from ${who}`,
  preheader: String(message).trim().slice(0, 120),
  title: kindLabel,
  blocks: [
    { type: 'rows', rows: [['From', `${who} (${String(role || '').toLowerCase()})`], ['Email', email || 'Not on file'], ['Page', page || ''], ['Account ID', profileId]] },
    { type: 'quote', text: message },
  ],
  replyNote: email ? 'Replying to this email writes straight to the person who sent the report.' : 'This person has no email on file.',
  reason: 'Sent to the support inbox from Report an Issue.',
});

module.exports = {
  configureShop,
  getShop,
  send,
  deliver,
  sendPasswordConfirmationEmail,
  sendPasswordChangedEmail,
  sendWrongPasswordSecurityNotice,
  sendEmergencyRecoveryEmail,
  sendEmailChangeCode,
  sendInviteAccountEmail,
  sendQrChangeOtpEmail,
  sendAnnouncementEmail,
  sendPromoEmail,
  sendInquiryReplyEmail,
  sendInquiryToShopEmail,
  sendSupportReportEmail,
};
