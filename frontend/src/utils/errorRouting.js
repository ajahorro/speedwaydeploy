/**
 * errorRouting.js
 * ============================================================================
 * Batch 7 / Step 7.3 — Error-message & modal ROUTING policy.
 *
 * The app has two legitimate, distinct feedback surfaces and this module is the
 * single place that decides which one a given failure belongs on:
 *
 *   1. <ValidationModal>  — scheduling conflicts, capacity limits, lead-time /
 *                           advance-window violations, and server-side hard
 *                           blocks. These are decisions the user must act on
 *                           (pick another time/date), so a transient toast is
 *                           the wrong surface: it can be missed entirely.
 *
 *   2. react-hot-toast    — transient, form-level, or operational system
 *                           notifications (save succeeded, network blip, etc).
 *
 * The backends do not always hand back the structured `code` the validator
 * endpoint uses. The `reschedule_booking` RPC, for example, raises plain
 * human-readable messages ("The selected time is full..."), and the browser's
 * own slot fetch can fail. `classifyScheduleError` bridges that gap: it inspects
 * an error (string, Error, or a Supabase/PostgREST error object) and returns the
 * matching ValidationModal `code`, or `null` when the failure is NOT a schedule
 * decision and should therefore go to a toast instead.
 *
 * The returned codes mirror the backend vocabulary consumed by ValidationModal:
 *   PAST_DATE, CLOSED_WEEKDAY, BLOCKED_DATE, BEYOND_ADVANCE_WINDOW,
 *   LEAD_TIME, SLOT_UNAVAILABLE, CAPACITY_EXCEEDED, VALIDATION_UNAVAILABLE
 */

/** Extract a comparable lowercase string from any thrown value. */
const toText = (error) => {
  if (!error) return '';
  if (typeof error === 'string') return error;
  // Prefer the most specific fields first.
  return [error.message, error.details, error.hint, error.error]
    .filter(Boolean)
    .join(' ');
};

// Ordered rules: the FIRST match wins. Order matters.
//
// PAST_DATE and CAPACITY_EXCEEDED come first because their messages are the
// most consequential and unambiguous. SLOT_UNAVAILABLE is then checked BEFORE
// BLOCKED_DATE and must require explicit *slot* language, because the
// validator's slot message ("The shop has reserved or blocked this slot")
// contains the word "blocked" and would otherwise be misread as a blocked
// DATE. BLOCKED_DATE is deliberately restricted to *date* wording.
const RULES = [
  { code: 'PAST_DATE', re: /in the past|has passed|cannot be in the past|choose a future|future date and time/i },
  { code: 'CAPACITY_EXCEEDED', re: /fully booked|is full|no ?bays? available|capacity|all bays/i },
  { code: 'SLOT_UNAVAILABLE', re: /reserved or blocked|slot unavailable|this slot|choose another (appointment )?time|not available/i },
  { code: 'BLOCKED_DATE', re: /blocked date|date is blocked|date (is )?(un)?available|marked this date|shop (has )?closed/i },
  { code: 'CLOSED_WEEKDAY', re: /closed on that day|shop is closed|closed weekday/i },
  { code: 'BEYOND_ADVANCE_WINDOW', re: /too far|advance window|max(imum)? advance/i },
  { code: 'LEAD_TIME', re: /too soon|lead time|more notice/i },
  { code: 'VALIDATION_UNAVAILABLE', re: /unavailable|unreachable|network|failed to fetch|timed? ?out/i },
];

/**
 * Classify an error against the schedule-decision vocabulary.
 *
 * @param {*} error - anything thrown: string, Error, or PostgREST error object.
 * @returns {string|null} a ValidationModal code, or null when this is NOT a
 *   schedule decision (caller should fall back to a toast).
 */
export const classifyScheduleError = (error) => {
  const text = toText(error);
  if (!text.trim()) return null;

  for (const { code, re } of RULES) {
    if (re.test(text)) return code;
  }
  return null;
};

/**
 * A raw DB/exception message is often fine as-is for display, but it can also be
 * long or leak internal wording. This trims it to a single short line so a
 * ValidationModal (or toast) stays readable.
 */
export const toCleanMessage = (error, fallback = '') => {
  const text = toText(error).trim();
  if (!text) return fallback;
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
};

export default { classifyScheduleError, toCleanMessage };