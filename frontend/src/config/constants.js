/**
 * SPEEDWAY GLOBAL CONFIGURATION
 * Centralized constants for white-label scalability.
 * REQ-NFR-01, REQ-NFR-05: Single source of truth for all business rules.
 */

// ─── SHOP CAPACITY ───────────────────────────────────────────────
export const SHOP_CONFIG = {
  MAX_BAYS: 7,                          // Max simultaneous car units
  MAX_MOTORCYCLE_BAYS: 15,              // Max simultaneous motorcycle units
  STALE_SESSION_PURGE_MINUTES: 30,      // Auto-purge unstarted sessions
  OPENING_HOUR: 7,                      // 7 AM
  CLOSING_HOUR: 21,                     // 9 PM
  FULL_DAY_THRESHOLD_MINUTES: 720,      // 12 hours
  LONG_TERM_THRESHOLD_MINUTES: 480,     // 8 hours (for occupancy logic)
  BOOKING_CLEANUP_BUFFER_MINUTES: 60,   // 1-hour bay cleanup/handover buffer added to every booking end_datetime
};


// ─── OPERATIONAL THRESHOLDS ──────────────────────────────────────
export const THRESHOLDS = {
  NOSHOW_GRACE_MINUTES: 60,             // REQ-SYS-02: Auto-flag after 1 hour
  URGENT_REMINDER_MINUTES: 15,          // REQ-SYS-02: Send reminder at 15m
};

// ─── CAPACITY ALERTING ───────────────────────────────────────────
export const CAPACITY_THRESHOLD = {
  CRITICAL: 7,   // Red Alert
  HIGH: 4,       // Amber Warning
  LOW: 1         // Green Safe
};

// ─── STATUS ENUMS ────────────────────────────────────────────────
export const BOOKING_STATUSES = {
  SCHEDULED: 'scheduled',
  CONFIRMED: 'confirmed',
  PENDING_CONFIRMATION: 'pending_confirmation',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  RELEASED: 'released',
  CANCELLED: 'cancelled',
  FLAGGED_NOSHOW: 'FLAGGED_NOSHOW',
  NO_SHOW: 'no_show',
};

export const VEHICLE_STATUSES = {
  QUEUED: 'QUEUED',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
};

export const VEHICLE_TYPE_OPTIONS = [
  { value: 'Sedan', label: 'Sedan' },
  { value: 'SUV', label: 'SUV' },
  { value: 'Van/L300', label: 'Van / L300' },
  { value: 'Regular', label: 'Motorcycle (Regular)' },
  { value: 'Bigbike', label: 'Motorcycle (Bigbike)' }
];

export const sanitizeVehiclePlate = (value = '') => value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
export const sanitizeVehicleText = (value = '') => value.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ');

// ─── Task B: STRICT ALPHANUMERIC INPUT GUARD ─────────────────────────────────
// Canonical allow-list: letters, digits and whitespace only (no special chars).
// Used by every free-text input across the system (names, addresses, notes,
// plate numbers) so a paste of `"><script>` or `₱1,000!!` can never land in the
// DB. Sanitising and validating are intentionally separate: `sanitizeAlphaNum`
// cleans on input; `isAlphaNum` gates submission.
export const ALPHANUMERIC_PATTERN = /^[a-zA-Z0-9\s]+$/;
export const sanitizeAlphaNum = (value = '') =>
  String(value).replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ' ');
export const isAlphaNum = (value = '') =>
  ALPHANUMERIC_PATTERN.test(String(value).trim());

// ─── Task 2.5: CONTEXT-AWARE FIELD-TYPE SANITIZATION (Option b) ─────────────
// Strict alphanumeric is the default for free text, plates, model names and
// general fields. Specialized inputs use a field-appropriate allowlist so
// legitimate characters survive (email punctuation, currency decimals, address
// hyphens/commas). Every sanitizer strips `<`/`>`/`"`/`'`/`/` first, so an
// injected HTML tag or script payload can never reach the DB through ANY field.
const stripDangerous = (value = '') => String(value).replace(/[<>"'`]/g, '');

export const sanitizeEmail = (value = '') =>
  stripDangerous(value).replace(/[^a-zA-Z0-9@._+-]/g, '').replace(/\.{2,}/g, '.');

export const sanitizeCurrency = (value = '') => {
  // Digits and at most one decimal point; normalizes a leading dot.
  const cleaned = stripDangerous(value).replace(/[^0-9.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  return rest.length ? `${whole}.${rest.join('')}` : whole;
};

export const sanitizeAddress = (value = '') =>
  stripDangerous(value).replace(/[^a-zA-Z0-9\s,.\-/#]/g, '').replace(/\s+/g, ' ');

export const sanitizePhone = (value = '') => stripDangerous(value).replace(/\D/g, '').slice(0, 15);

// Same alphanumeric policy as sanitizeAlphaNum but named for field-type clarity.
export const sanitizeText = (value = '') => sanitizeAlphaNum(value);

// Canonical field-type → sanitizer map. Anything not listed falls back to the
// strict alphanumeric guard, which is the safe default.
export const FIELD_SANITIZERS = Object.freeze({
  text: sanitizeText,
  alphaNum: sanitizeAlphaNum,
  plate: sanitizeVehiclePlate,
  model: sanitizeVehicleText,
  email: sanitizeEmail,
  currency: sanitizeCurrency,
  address: sanitizeAddress,
  phone: sanitizePhone,
});

/**
 * sanitizeByFieldType — the single entry point for context-aware cleaning.
 * @param {string} value
 * @param {string} fieldType one of FIELD_SANITIZERS keys (defaults to 'alphaNum')
 */
export const sanitizeByFieldType = (value = '', fieldType = 'alphaNum') => {
  const sanitizer = FIELD_SANITIZERS[fieldType] || sanitizeAlphaNum;
  return sanitizer(value);
};

// Security guard: does a raw string contain any HTML tag / script injection?
export const containsUnsafeHtml = (value = '') =>
  /<[^>]*>|javascript:|<\/?script|on\w+\s*=/i.test(String(value));

// ─── Task B: PAYMENT FEE + OVERPAYMENT CONSTANTS ────────────────────────────
// Cross-bank / e-wallet transfer fee defense. GoTyme and other cross-bank
// transfers deduct a fee before the amount lands, so the CREDITED figure is
// (total deducted − transfer fee). Defaults to a flat fee unless overridden by
// business_config.transfer_fee.
export const DEFAULT_TRANSFER_FEE = 0;
export const CREDIT_LEDGER = Object.freeze({
  EXCESS: 'EXCESS',
  ABSORBED: 'ABSORBED',
  REFUND_QUEUED: 'REFUND_QUEUED',
  ADJUSTMENT: 'ADJUSTMENT',
});

// ─── UNIFIED STATUS COLORS ──────────────────────────────────────
// Extracted from AdminBookings, SchedulingGrid, CustomerBookingDetails
export const STATUS_COLORS = {
  scheduled: '#E61E2A',                 // Brand red
  confirmed: '#3b82f6',                 // Info blue
  in_progress: '#a855f7',              // Purple
  completed: '#10b981',                // Green
  released: '#14b8a6',                 // Teal
  cancelled: '#ef4444',                // Red
  flagged_noshow: '#ef4444',           // Red (urgent)
  queued: '#f59e0b',                   // Amber
  pending: '#f59e0b',                  // Amber
  default: '#6b7280',                  // Muted gray
};

// ─── DESIGN TOKENS ───────────────────────────────────────────────
export const COLORS = {
  BRAND: 'var(--admin-brand)',
  SUCCESS: '#10b981',
  WARNING: '#f59e0b',
  DANGER: '#ef4444',
  MUTED: '#6b7280',
  BG_CARD: 'var(--admin-card)',
  BORDER: 'var(--admin-border)'
};
