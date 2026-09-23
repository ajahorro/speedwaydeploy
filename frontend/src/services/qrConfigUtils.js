import { isAlphaNum } from '../config/constants.js';

export const QR_FIELDS = [
  { key: 'qr_account_name', label: 'QR Account Name' },
  { key: 'qr_account_number', label: 'QR Account Number' },
  { key: 'fallback_receiver_name', label: 'Fallback Receiver Name' },
  { key: 'fallback_receiver_number', label: 'Fallback Receiver Number' },
];

export const normalizeQrConfig = (config = {}) => ({
  qr_account_name: String(config.qr_account_name ?? '').trim(),
  qr_account_number: String(config.qr_account_number ?? '').trim(),
  fallback_receiver_name: String(config.fallback_receiver_name ?? '').trim(),
  fallback_receiver_number: String(config.fallback_receiver_number ?? '').trim(),
  payment_qr_url: String(config.payment_qr_url ?? config.gcash_qr_url ?? config.qr_photo_url ?? '').trim(),
  gcash_qr_url: String(config.gcash_qr_url ?? config.payment_qr_url ?? config.qr_photo_url ?? '').trim(),
  qr_photo_url: String(config.qr_photo_url ?? config.payment_qr_url ?? config.gcash_qr_url ?? '').trim(),
});

export const buildQrSubmission = (config = {}) => {
  const normalized = normalizeQrConfig(config);
  return {
    qr_account_name: normalized.qr_account_name,
    qr_account_number: normalized.qr_account_number,
    fallback_receiver_name: normalized.fallback_receiver_name,
    fallback_receiver_number: normalized.fallback_receiver_number,
    payment_qr_url: normalized.payment_qr_url,
    gcash_qr_url: normalized.gcash_qr_url,
    qr_photo_url: normalized.qr_photo_url,
  };
};

const isValidOptionalUrl = (value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
};

export const validateQrRecipients = (config = {}) => {
  const normalized = normalizeQrConfig(config);
  const missing = [];
  const invalid = [];

  for (const { key, label } of QR_FIELDS) {
    const raw = normalized[key] ?? '';
    if (!raw) {
      missing.push(label);
      continue;
    }
    const normalised = raw.replace(/[-\s]/g, '');
    if (!isAlphaNum(normalised)) invalid.push(label);
  }

  const optionalQrUrl = normalized.payment_qr_url || normalized.gcash_qr_url || normalized.qr_photo_url;
  if (optionalQrUrl && !isValidOptionalUrl(optionalQrUrl)) invalid.push('QR Photo URL');

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
};
