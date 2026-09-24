/**
 * Batch 6 — Schedule Rules Engine (pure module)
 * =============================================
 *
 * SINGLE SOURCE OF TRUTH for "can this date / slot be booked?".
 *
 * This module is deliberately PURE JavaScript: no React, no Supabase, no DOM,
 * no `import` of any app service. It takes plain data in and returns plain
 * decisions out. That lets three very different callers share one implementation:
 *
 *   1. The customer booking calendar (browser).
 *   2. The admin scheduling surface (browser).
 *   3. The backend validation on POST /api/bookings (Node) — imported directly
 *      so the client can never disagree with the server about what is bookable.
 *
 * Design rules:
 *   - Never throw on missing / malformed config: fall back to safe defaults so a
 *     half-provisioned `business_config` row can never block all bookings.
 *   - Every decision is returned as a structured result `{ bookable, code, reason }`
 *     so the UI can render a specific <ValidationModal> message and the server can
 *     return a machine-readable error code. `code` is stable; `reason` is human.
 *   - Date math is done in LOCAL time on day boundaries to match how
 *     `scheduleService` and the booking wizard build slot timestamps
 *     (`${dateStr}T${HH}:${MM}:00`), avoiding UTC off-by-one-day drift.
 *
 * Weekday numbering is JS-style 0=Sun .. 6=Sat, matching `Date.getDay()` on the
 * client and the `closed_weekdays` column added in migration
 * 20260925000001_add_schedule_rules.sql.
 */

// ─── Stable decision codes (safe to branch on in UI + server) ────────────────

export const SCHEDULE_DECISION_CODES = Object.freeze({
  OK: 'OK',
  PAST_DATE: 'PAST_DATE',
  CLOSED_WEEKDAY: 'CLOSED_WEEKDAY',
  BLOCKED_DATE: 'BLOCKED_DATE',
  BEYOND_ADVANCE_WINDOW: 'BEYOND_ADVANCE_WINDOW',
  LEAD_TIME: 'LEAD_TIME',
  SLOT_BLOCKED: 'SLOT_BLOCKED',
  SLOT_FULL: 'SLOT_FULL',
  INVALID_DATE: 'INVALID_DATE',
  INVALID_SLOT: 'INVALID_SLOT',
});

// ─── Defaults (must mirror the SQL defaults in the migration) ────────────────

export const SCHEDULE_DEFAULTS = Object.freeze({
  booking_lead_time_minutes: 5,
  max_advance_days: 30,
  closed_weekdays: [],
  enforce_capacity: true,
  slots_per_hour: 1,
  max_vehicles_per_staff: 4,
  opening_hour: 7,
  closing_hour: 21,
  is_24_7: false,
});

// A 24/7 shop occupies the whole day. We express that as opening=0, closing=24
// where closing=24 means "the end of the day" (1440 minutes). Keeping it as a
// derived pair — rather than special-casing every consumer — means the slot
// generator ([open, close)) and the "finishes within hours" check both just work.
const FULL_DAY_OPEN_HOUR = 0;
const FULL_DAY_CLOSE_HOUR = 24;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

// ─── Internal helpers ────────────────────────────────────────────────────────

const ok = () => ({ bookable: true, code: SCHEDULE_DECISION_CODES.OK, reason: null });
const no = (code, reason) => ({ bookable: false, code, reason });

/**
 * Parses 'YYYY-MM-DD' (optionally with a time suffix) into a local Date at
 * midnight of that calendar day. Returns null when the value is unusable.
 */
const parseDateOnly = (date) => {
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) return null;
    // Normalise to local midnight so comparisons are day-accurate.
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }
  if (typeof date === 'string') {
    const match = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    const [, y, m, d] = match;
    const parsed = new Date(Number(y), Number(m) - 1, Number(d));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

/** Normalises business_config into a bounded config object with safe fallbacks. */
export const normalizeConfig = (config) => {
  const cfg = config || {};
  const int = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  // Business hours may arrive as an hour number (7), a 24h string ('07:00'), or
  // the legacy 12h display string ('07:00 AM'). Accept all three so an admin
  // time-picker value feeds the capacity/open-window math instead of silently
  // collapsing to the default hour.
  const hour = (value, fallback) => {
    if (value == null || value === '') return fallback;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const minutes = parseTimeToMinutes(value);
    return minutes == null ? fallback : Math.floor(minutes / 60);
  };
  const weekdays = Array.isArray(cfg.closed_weekdays)
    ? cfg.closed_weekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : [];

  // 24/7 wins over any stored hours: derive a full-day window so every hour is
  // bookable and the stored opening_hour/closing_hour are ignored.
  const is247 = cfg.is_24_7 === true;
  const openingHour = is247 ? FULL_DAY_OPEN_HOUR : hour(cfg.opening_hour, SCHEDULE_DEFAULTS.opening_hour);
  const closingHour = is247 ? FULL_DAY_CLOSE_HOUR : hour(cfg.closing_hour, SCHEDULE_DEFAULTS.closing_hour);

  return {
    booking_lead_time_minutes: Math.max(0, int(cfg.booking_lead_time_minutes, SCHEDULE_DEFAULTS.booking_lead_time_minutes)),
    max_advance_days: Math.max(1, int(cfg.max_advance_days, SCHEDULE_DEFAULTS.max_advance_days)),
    closed_weekdays: weekdays,
    enforce_capacity: cfg.enforce_capacity !== false, // default ON unless explicitly false
    slots_per_hour: Math.max(1, int(cfg.slots_per_hour, SCHEDULE_DEFAULTS.slots_per_hour)),
    max_vehicles_per_staff: Math.max(1, int(cfg.max_vehicles_per_staff, SCHEDULE_DEFAULTS.max_vehicles_per_staff)),
    opening_hour: openingHour,
    // closing_hour may legitimately be 24 for a 24/7 shop (end of day).
    closing_hour: closingHour,
    is_24_7: is247,
  };
};

/**
 * Parses a 'HH:MM' (24h) or 'HH:MM AM/PM' time string into minutes-from-midnight.
 * Mirrors the tolerant parsing already used across scheduleService.
 */
const parseTimeToMinutes = (value) => {
  if (value == null) return null;
  const raw = String(value).trim().toUpperCase();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

/** Parses the `slot` argument into { hour, minute } or null. */
const parseSlot = (slot) => {
  if (slot == null) return null;
  if (typeof slot === 'object') {
    const hour = Number(slot.hour);
    const minute = Number(slot.minute ?? 0);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }
  if (typeof slot === 'string') {
    const minutes = parseTimeToMinutes(slot);
    if (minutes == null) return null;
    return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
  }
  if (typeof slot === 'number') {
    if (slot < 0 || slot > 23) return null;
    return { hour: slot, minute: 0 };
  }
  return null;
};

/** Builds a local Date for `dateStr` + the given hour/minute. */
const slotToDate = (day, hour, minute) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);

/**
 * Does the requested window overlap a blocked_slots row ON A GIVEN DAY?
 * A row with no start_time is a whole-day block.
 *
 * `dayOffset` lets a multi-day service check the FOLLOWING day's blocks when it
 * crosses midnight: the caller passes the rows for that day plus its offset.
 */
const isWindowBlockedOnDay = (startMinutes, endMinutes, blocks, dayOffset) =>
  (blocks || []).some((block) => {
    if (!block) return false;
    const blockStart = parseTimeToMinutes(block.start_time);
    const blockEnd = parseTimeToMinutes(block.end_time);
    if (blockStart == null) return true; // whole-day block
    const end = blockEnd == null ? 24 * 60 : blockEnd;
    // Shift the block into the same "minutes since the service start day"
    // coordinate space by adding the day offset.
    const offset = dayOffset * 24 * 60;
    return startMinutes < end + offset && endMinutes > blockStart + offset;
  });

/**
 * Does the requested [start, end) window overlap a block, across every calendar
 * day the window touches? `blocksByDay` is [{ offset, blocks }] where offset is
 * days from the start day (0 = start day, 1 = next day, ...).
 */
const isWindowBlocked = (startMinutes, durationMinutes, blocksByDay) => {
  const endMinutes = startMinutes + durationMinutes;
  return (blocksByDay || []).some((entry) =>
    isWindowBlockedOnDay(startMinutes, endMinutes, entry?.blocks || [], entry?.offset || 0));
};

const normalizeStatus = (status) => String(status || '').toLowerCase();
const NON_BLOCKING_STATUSES = ['cancelled', 'completed', 'flagged_noshow', 'released'];

/** How many bay-units a single booking occupies (bikes = 0.5, cars = 1). */
const vehicleUnits = (vehicle) => {
  const type = String(vehicle?.vehicle_type || vehicle?.type || vehicle?.vehicleType || '').toUpperCase();
  if (['REGULAR', 'BIGBIKE', 'MOTORCYCLE', 'BIG_BIKE', 'MOTORBIKE'].includes(type)) return 0.5;
  return 1;
};

/** Total bays consumed by the vehicles attached to one booking (min 1). */
const bookingBayUsage = (booking) => {
  const vehicles = Array.isArray(booking?.vehicles) ? booking.vehicles : [];
  if (vehicles.length === 0) return 1; // legacy booking without relations
  const bikes = vehicles.filter((v) => vehicleUnits(v) === 0.5).length;
  const full = vehicles.length - bikes;
  return Math.max(1, full + Math.ceil(bikes / 2));
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Can the given calendar DATE be opened for booking at all?
 * Checks: valid date, not in the past, not a closed weekday, not admin-blocked,
 * and within the advance-booking window.
 *
 * @param {string|Date} date - 'YYYY-MM-DD' or a Date.
 * @param {object} config - a business_config row (or normalized config).
 * @param {object} [options]
 * @param {Array}  [options.blocks] - blocked_slots rows applicable to `date`.
 * @param {Date}   [options.now] - injectable clock for deterministic tests.
 * @returns {{ bookable: boolean, code: string, reason: string|null }}
 */
export const isDateBookable = (date, config, options = {}) => {
  const cfg = normalizeConfig(config);
  const now = options.now instanceof Date ? options.now : new Date();
  const blocks = options.blocks || [];

  const day = parseDateOnly(date);
  if (!day) return no(SCHEDULE_DECISION_CODES.INVALID_DATE, 'That date could not be understood.');

  // Local-midnight boundaries.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 1. Past-date prevention (compare whole days, not instants).
  if (day.getTime() < today.getTime()) {
    return no(SCHEDULE_DECISION_CODES.PAST_DATE, 'Past dates cannot be booked.');
  }

  // 2. Closed weekday.
  if (cfg.closed_weekdays.includes(day.getDay())) {
    return no(SCHEDULE_DECISION_CODES.CLOSED_WEEKDAY, 'The shop is closed on this day of the week.');
  }

  // 3. Maximum advance-booking window (inclusive of the last day).
  const daysAhead = Math.round((day.getTime() - today.getTime()) / MS_PER_DAY);
  if (daysAhead > cfg.max_advance_days) {
    return no(
      SCHEDULE_DECISION_CODES.BEYOND_ADVANCE_WINDOW,
      `Bookings can be made at most ${cfg.max_advance_days} days in advance.`
    );
  }

  // 4. Admin-blocked full days (a whole-day block closes the date).
  const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const wholeDayBlock = (blocks || []).some(
    (b) => b && String(b.block_date || '').slice(0, 10) === dateStr && parseTimeToMinutes(b.start_time) == null
  );
  if (wholeDayBlock) {
    return no(SCHEDULE_DECISION_CODES.BLOCKED_DATE, 'This date has been blocked by the shop.');
  }

  return ok();
};

/**
 * Can a specific SLOT on a date be booked, given what is already on the books?
 * Assumes the date itself is bookable (call isDateBookable first) but re-checks
 * the date so a caller cannot skip it by accident.
 *
 * Spanning: a service may run past closing, cross midnight, or span multiple
 * days. For a 24/7 shop (is_24_7) NO closing bound applies; for a finite shop the
 * service must still finish by closing time on the START day. Admin blocks and
 * capacity are always evaluated across EVERY calendar day the window touches,
 * so the caller must pass the blocks and bookings for the whole span.
 *
 * Capacity model:
 *   - `slots_per_hour`  = total bookable bays/slots per hourly bucket.
 *   - `max_vehicles_per_staff` = per-staff ceiling; combined with staff on duty
 *     it caps how many vehicles may run concurrently (see `staffOnDuty` option).
 *   - A partial blocked_slots row removes capacity for its time window.
 *
 * @param {string|Date} date
 * @param {{hour:number, minute?:number}|string} slot
 * @param {object} config
 * @param {Array}  [existingBookings] - bookings overlapping the requested span.
 * @param {object} [options]
 * @param {Array}  [options.blocks] - blocked_slots rows for every day in the span.
 * @param {number} [options.durationMinutes=60] - requested service duration.
 * @param {number} [options.staffOnDuty=1] - staff available (for per-staff cap).
 * @param {number} [options.requestedBays=1] - bays this new booking needs.
 * @param {boolean} [options.skipLeadTime=false] - admin/desk path: the customer is
 *   physically present, so the customer-facing "minimum advance notice" does not
 *   apply. A hard floor at `now` still does: the slot may not start earlier than
 *   the current instant (no same-day back-dating). Capacity, blocks, closed days
 *   and past-date are also still enforced.
 * @param {Date}   [options.now]
 * @returns {{ bookable: boolean, code: string, reason: string|null, remaining?: number }}
 */
export const isSlotBookable = (date, slot, config, existingBookings = [], options = {}) => {
  const cfg = normalizeConfig(config);
  const now = options.now instanceof Date ? options.now : new Date();
  const blocks = options.blocks || [];
  const durationMinutes = Math.max(1, Number(options.durationMinutes) || 60);
  const requestedBays = Math.max(1, Number(options.requestedBays) || 1);
  const skipLeadTime = options.skipLeadTime === true;

  // Date-level gate first (re-checked defensively).
  const dateCheck = isDateBookable(date, cfg, { blocks, now });
  if (!dateCheck.bookable) return dateCheck;

  const day = parseDateOnly(date);
  const parsed = parseSlot(slot);
  if (!parsed) return no(SCHEDULE_DECISION_CODES.INVALID_SLOT, 'That time slot could not be understood.');

  const slotStart = slotToDate(day, parsed.hour, parsed.minute);
  const startMinutes = parsed.hour * 60 + parsed.minute;
  const slotEnd = new Date(slotStart.getTime() + durationMinutes * MS_PER_MINUTE);

  // 1. Lead time. Two regimes:
  //    - Customer path: the slot must be at least `booking_lead_time_minutes`
  //      away (a strict buffer absorbs the seconds between clicking "book" and
  //      the slot start, so a booking made at 4:59:50 for 5:00 is rejected).
  //    - Admin/desk path (skipLeadTime): the customer-facing notice window is
  //      waived, BUT a hard floor at `now` still applies — an admin can never
  //      schedule a time earlier than the current instant, even later today.
  //      Back-dating would corrupt capacity math and technician shift tracking.
  if (skipLeadTime) {
    if (slotStart.getTime() < now.getTime()) {
      return no(
        SCHEDULE_DECISION_CODES.LEAD_TIME,
        'That time has already passed. Choose the current time or later.'
      );
    }
  } else {
    const leadMs = cfg.booking_lead_time_minutes * MS_PER_MINUTE;
    if (slotStart.getTime() < now.getTime() + leadMs) {
      const hours = Math.round((cfg.booking_lead_time_minutes / 60) * 10) / 10;
      return no(
        SCHEDULE_DECISION_CODES.LEAD_TIME,
        `Bookings need at least ${hours} hour(s) of lead time. Please pick a later slot.`
      );
    }
  }

  // 2. Operating-hours bound.
  //    - Finite shop: the service must finish by closing time on the START day
  //      (a 7-21 shop cannot run a 4-hour job from 20:00 to midnight).
  //    - 24/7 shop: there is no closing time, so a service MAY cross midnight and
  //      may span multiple days (a vehicle staged for 2+ days). No bound applies.
  if (!cfg.is_24_7 && slotEnd.getTime() > slotToDate(day, cfg.closing_hour, 0).getTime()) {
    return no(
      SCHEDULE_DECISION_CODES.SLOT_BLOCKED,
      `The service would run past closing time (${cfg.closing_hour}:00). Please choose an earlier slot.`
    );
  }

  // 3. Admin blocks across EVERY day the service touches (a midnight-spanning or
  //    multi-day service must respect the next day's blocks too). We build the
  //    { offset, blocks } list from the rows the caller supplied (which cover the
  //    full span — see loadScheduleContext / scheduleService).
  const spanDays = Math.floor((startMinutes + durationMinutes - 1) / (24 * 60));
  const blocksByDay = [];
  for (let offset = 0; offset <= spanDays; offset += 1) {
    const dayKey = dateKey(new Date(day.getTime() + offset * MS_PER_DAY));
    blocksByDay.push({
      offset,
      blocks: (blocks || []).filter((b) => b && String(b.block_date || '').slice(0, 10) === dayKey),
    });
  }
  if (isWindowBlocked(startMinutes, durationMinutes, blocksByDay)) {
    return no(SCHEDULE_DECISION_CODES.SLOT_BLOCKED, 'This time has been blocked by the shop.');
  }

  if (!cfg.enforce_capacity) return { ...ok(), remaining: cfg.slots_per_hour };

  // 4. Capacity: sum bays used by overlapping, non-terminal bookings.
  const overlapping = (existingBookings || []).filter((booking) => {
    if (!booking) return false;
    if (NON_BLOCKING_STATUSES.includes(normalizeStatus(booking.status))) return false;
    const start = new Date(booking.start_datetime);
    const end = new Date(booking.end_datetime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
    return start < slotEnd && end > slotStart;
  });

  const usedBays = overlapping.reduce((sum, booking) => sum + bookingBayUsage(booking), 0);

  // Bay ceiling for this window.
  const bayCeiling = cfg.slots_per_hour;

  // Per-staff ceiling, expressed as concurrent vehicles across the window.
  const staffOnDuty = Math.max(1, Number(options.staffOnDuty) || 1);
  const staffCeiling = cfg.max_vehicles_per_staff * staffOnDuty;

  const ceiling = Math.min(bayCeiling, staffCeiling);
  const remaining = ceiling - usedBays;

  if (remaining < requestedBays) {
    return no(
      SCHEDULE_DECISION_CODES.SLOT_FULL,
      remaining <= 0
        ? 'That slot is fully booked. Please choose another time.'
        : `Only ${remaining} slot(s) left at this time — this booking needs ${requestedBays}.`
    );
  }

  return { ...ok(), remaining };
};

/**
 * Enumerates every bookable start slot for a date, each annotated with its
 * remaining capacity. Slot granularity defaults to 30 minutes, matching the
 * existing booking wizard.
 *
 * @param {string|Date} date
 * @param {object} config
 * @param {Array}  [existingBookings]
 * @param {object} [options] - same options as isSlotBookable, plus:
 *        `granularity` (minutes, default 30) and `durationMinutes`.
 * @returns {Array<{hour:number, minute:number, minutes:number, remaining:number}>}
 */
export const getBookableSlots = (date, config, existingBookings = [], options = {}) => {
  const cfg = normalizeConfig(config);
  const granularity = Math.max(1, Number(options.granularity) || 30);

  const dateCheck = isDateBookable(date, cfg, options);
  if (!dateCheck.bookable) return [];

  const openMinutes = cfg.opening_hour * 60;
  const closeMinutes = cfg.closing_hour * 60;

  const slots = [];
  for (let minutes = openMinutes; minutes < closeMinutes; minutes += granularity) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const decision = isSlotBookable(date, { hour, minute }, cfg, existingBookings, options);
    if (decision.bookable) {
      slots.push({
        hour,
        minute,
        minutes,
        remaining: decision.remaining ?? cfg.slots_per_hour,
      });
    }
  }
  return slots;
};

/** Local 'YYYY-MM-DD' key for a Date (module-local helper, exported for reuse). */
export function dateKey(date) {
  const d = parseDateOnly(date);
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default {
  isDateBookable,
  isSlotBookable,
  getBookableSlots,
  normalizeConfig,
  dateKey,
  SCHEDULE_DEFAULTS,
  SCHEDULE_DECISION_CODES,
};
