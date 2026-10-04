/**
 * Phone and email rules, in one place.
 *
 * The same rules exist in backend/config/contactValidation.js and in the database
 * (normalize_ph_phone / is_valid_email). scripts/verify-contact-rules.mjs checks
 * that the two JavaScript copies agree, so a change here must be made there too.
 *
 * Phone: a Philippine mobile number, stored as 11 digits starting with 09
 * (09123456789). Spaces, dashes, brackets and a +63 / 63 / 9xxxxxxxxx prefix are
 * accepted when typed or pasted and normalised to that form.
 *
 * Email: trimmed, lower-case, one @, a dotted domain with a 2+ letter ending,
 * no spaces, at most 254 characters.
 */

export const PHONE_LENGTH = 11;
export const EMAIL_MAX_LENGTH = 254;

const PHONE_PATTERN = /^09\d{9}$/;
const EMAIL_PATTERN = /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Normalise anything a person might type or paste for a phone number to the
 * stored form where possible. Returns digits only; may still be invalid.
 */
export const normalizePhPhone = (value) => {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.startsWith('9') && digits.length === 10) digits = `0${digits}`;
  return digits;
};

/** Live filter while typing: digits only, +63 pastes folded to 09, max 11. */
export const sanitizePhoneInput = (value) => {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length >= 12) digits = `0${digits.slice(2)}`;
  return digits.slice(0, PHONE_LENGTH);
};

export const isValidPhPhone = (value) => PHONE_PATTERN.test(normalizePhPhone(value));

/** Returns an error message, or '' when fine. Empty is only an error when required. */
export const phoneError = (value, { required = true } = {}) => {
  const raw = String(value ?? '').trim();
  if (!raw) return required ? 'Enter a mobile number.' : '';
  return isValidPhPhone(raw) ? '' : 'Enter an 11-digit mobile number starting with 09 (for example 09123456789).';
};

export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

/** Live filter while typing: no whitespace or markup characters. */
export const sanitizeEmailInput = (value) =>
  String(value ?? '').replace(/[\s<>"'`]/g, '').slice(0, EMAIL_MAX_LENGTH);

export const isValidEmail = (value) => {
  const email = normalizeEmail(value);
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email) && !email.includes('..');
};

export const emailError = (value, { required = true } = {}) => {
  const raw = String(value ?? '').trim();
  if (!raw) return required ? 'Enter an email address.' : '';
  return isValidEmail(raw) ? '' : 'Enter a valid email address, such as name@example.com.';
};
