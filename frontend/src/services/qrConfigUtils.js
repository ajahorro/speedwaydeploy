import { isAlphaNum } from '../config/constants.js';

export const sanitizeQrAccountName = (value = '') => String(value ?? '').replace(/[^a-zA-Z\s]/g, '').replace(/\s+/g, ' ');
export const sanitizeQrAccountNumber = (value = '') => String(value ?? '').replace(/[^\d\s-]/g, '').replace(/\s+/g, ' ');

export const QR_FIELDS = [
  { key: 'qr_account_name', label: 'QR Account Name' },
  { key: 'qr_account_number', label: 'QR Account Number' },
];

export const normalizeQrConfig = (config = {}) => {
  const qrCodeUrl = String(
    config.qr_code_url ?? config.payment_qr_url ?? config.gcash_qr_url ?? config.qr_photo_url ?? ''
  ).trim();

  return {
    qr_account_name: sanitizeQrAccountName(config.qr_account_name ?? ''),
    qr_account_number: sanitizeQrAccountNumber(config.qr_account_number ?? ''),
    payment_qr_url: qrCodeUrl,
    gcash_qr_url: qrCodeUrl,
    qr_photo_url: qrCodeUrl,
    qr_code_url: qrCodeUrl,
    fallback_receiver_name: '',
    fallback_receiver_number: '',
  };
};

export const buildQrSubmission = (config = {}) => {
  const normalized = normalizeQrConfig(config);
  return {
    qr_account_name: normalized.qr_account_name,
    qr_account_number: normalized.qr_account_number,
    payment_qr_url: normalized.payment_qr_url,
    gcash_qr_url: normalized.gcash_qr_url,
    qr_photo_url: normalized.qr_photo_url,
    qr_code_url: normalized.qr_code_url,
    fallback_receiver_name: normalized.fallback_receiver_name,
    fallback_receiver_number: normalized.fallback_receiver_number,
  };
};

const isValidOptionalUrl = (value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'data:'].includes(url.protocol);
  } catch {
    return false;
  }
};

export const validateQrRecipients = (config = {}) => {
  const normalized = normalizeQrConfig(config);
  const missing = [];
  const invalid = [];

  const rawName = String(config.qr_account_name ?? '');
  if (!rawName.trim()) {
    missing.push('QR Account Name');
  } else if (!/^[A-Za-z\s]+$/.test(rawName) || !rawName.replace(/\s+/g, ' ').trim()) {
    invalid.push('QR Account Name');
  }

  const rawNumber = String(config.qr_account_number ?? '');
  if (!rawNumber.trim()) {
    missing.push('QR Account Number');
  } else if (!/^[\d\s-]+$/.test(rawNumber) || rawNumber.replace(/\D/g, '').length === 0) {
    invalid.push('QR Account Number');
  }

  const optionalQrUrl = normalized.payment_qr_url || normalized.gcash_qr_url || normalized.qr_photo_url || normalized.qr_code_url;
  if (!optionalQrUrl) {
    missing.push('QR Photo');
  } else if (!isValidOptionalUrl(optionalQrUrl)) {
    invalid.push('QR Photo URL');
  }

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
};
