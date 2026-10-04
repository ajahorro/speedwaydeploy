/**
 * Phone and email rules (server copy).
 *
 * Mirrors frontend/src/utils/contactValidation.js and the database functions
 * normalize_ph_phone / is_valid_email. scripts/verify-contact-rules.mjs checks
 * that this file and the frontend module agree.
 */

const PHONE_LENGTH = 11;
const EMAIL_MAX_LENGTH = 254;

const PHONE_PATTERN = /^09\d{9}$/;
const EMAIL_PATTERN = /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

const normalizePhPhone = (value) => {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.startsWith('9') && digits.length === 10) digits = `0${digits}`;
  return digits;
};

const isValidPhPhone = (value) => PHONE_PATTERN.test(normalizePhPhone(value));

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

const isValidEmail = (value) => {
  const email = normalizeEmail(value);
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email) && !email.includes('..');
};

module.exports = {
  PHONE_LENGTH,
  EMAIL_MAX_LENGTH,
  normalizePhPhone,
  isValidPhPhone,
  normalizeEmail,
  isValidEmail
};
