/**
 * plateNormalization.js
 * Pure helpers for vehicle plate normalization and duplicate detection.
 *
 * Spec (QA Test Case 1.2): plates are compared case- and separator-insensitive,
 * so "ABC-123" and "abc 123" must both normalize to "ABC123" and be treated as
 * the same vehicle. Keeping this pure makes the rule trivially testable and
 * lets the wizard reuse it for both real-time field errors and submit gating.
 */

/**
 * Normalize a plate for comparison: uppercase and strip every non-alphanumeric
 * character. "abc 123" / "ABC-123" / "abc-123" all collapse to "ABC123".
 * @param {string} plate
 * @returns {string} comparison key ('' when the input holds no alphanumerics)
 */
export const normalizePlate = (plate) =>
  String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Find plates that appear on more than one distinct unit (or vehicle within a
 * unit). Only units that carry at least one alphanumeric are considered so an
 * empty, still-being-typed row never raises a false duplicate error.
 *
 * @param {Array} vehicles - booking vehicle records carrying `plateNumber`.
 * @returns {Set<string>} the set of normalized plates that are duplicated
 */
export const findDuplicatePlates = (vehicles = []) => {
  const seen = new Map();
  (vehicles || []).forEach((vehicle) => {
    const key = normalizePlate(vehicle?.plateNumber);
    if (!key) return;
    seen.set(key, (seen.get(key) || 0) + 1);
  });
  const duplicates = new Set();
  seen.forEach((count, key) => {
    if (count > 1) duplicates.add(key);
  });
  return duplicates;
};

/**
 * Whether a specific plate is duplicated within the booking.
 * @param {string} plate
 * @param {Array} vehicles
 * @returns {boolean}
 */
export const isDuplicatePlate = (plate, vehicles = []) => {
  const key = normalizePlate(plate);
  if (!key) return false;
  return findDuplicatePlates(vehicles).has(key);
};

/** Human-readable message for the field-level error banner. */
export const duplicatePlateMessage = (plate) =>
  `Plate ${normalizePlate(plate)} is already used by another vehicle in this booking.`;
