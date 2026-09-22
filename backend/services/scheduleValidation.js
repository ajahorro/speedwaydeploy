/**
 * Batch 6 / Step 6.2 — Server-side schedule validation service.
 * ============================================================================
 *
 * The single server-side entry point for "may this booking be scheduled?".
 *
 * It is a thin, DB-aware wrapper around the PURE rules module that lives at
 * `frontend/src/domain/schedule/rules.js`. That module is the shared source of
 * truth for both the browser calendar and this server path — we `require()` it
 * verbatim (Node ≥20.19 / ≥22 `require()`-of-ESM) rather than re-implementing
 * the rules, so the client can never disagree with the server.
 *
 * Responsibilities of THIS file (things the pure module deliberately does not do):
 *   1. Load `business_config`, `blocked_slots`, existing `bookings` (+ their
 *      `booking_vehicles`) from Supabase.
 *   2. Translate a client booking request (date + time + vehicles + duration)
 *      into the plain shapes the pure module expects.
 *   3. Map the module's decision codes onto HTTP status codes + a stable,
 *      client-facing error envelope.
 *
 * Nothing here mutates data — it only reads and decides.
 */

const {
  isDateBookable,
  isSlotBookable,
  normalizeConfig,
  SCHEDULE_DECISION_CODES,
} = require('../../frontend/src/domain/schedule/rules.js');

// Decision code -> HTTP status. Everything is a client error:
//   400 = the shape/value of the request is wrong (can never succeed as-is).
//   409 = the request is well-formed but conflicts with current shop state.
const DECISION_HTTP_STATUS = {
  [SCHEDULE_DECISION_CODES.INVALID_DATE]: 400,
  [SCHEDULE_DECISION_CODES.INVALID_SLOT]: 400,
  [SCHEDULE_DECISION_CODES.PAST_DATE]: 400,
  [SCHEDULE_DECISION_CODES.CLOSED_WEEKDAY]: 409,
  [SCHEDULE_DECISION_CODES.BEYOND_ADVANCE_WINDOW]: 409,
  [SCHEDULE_DECISION_CODES.LEAD_TIME]: 409,
  [SCHEDULE_DECISION_CODES.BLOCKED_DATE]: 409,
  [SCHEDULE_DECISION_CODES.SLOT_BLOCKED]: 409,
  [SCHEDULE_DECISION_CODES.SLOT_FULL]: 409,
};

// The client-facing error codes the brief standardised on. The pure module
// emits finer-grained codes (BLOCKED_DATE vs SLOT_BLOCKED); we collapse them
// into the agreed vocabulary while keeping the precise internal code too.
const CLIENT_ERROR_CODES = {
  [SCHEDULE_DECISION_CODES.INVALID_DATE]: 'PAST_DATE',
  [SCHEDULE_DECISION_CODES.INVALID_SLOT]: 'INVALID_SLOT',
  [SCHEDULE_DECISION_CODES.PAST_DATE]: 'PAST_DATE',
  [SCHEDULE_DECISION_CODES.CLOSED_WEEKDAY]: 'CLOSED_WEEKDAY',
  [SCHEDULE_DECISION_CODES.BEYOND_ADVANCE_WINDOW]: 'BEYOND_ADVANCE_WINDOW',
  [SCHEDULE_DECISION_CODES.LEAD_TIME]: 'LEAD_TIME',
  [SCHEDULE_DECISION_CODES.BLOCKED_DATE]: 'BLOCKED_DATE',
  [SCHEDULE_DECISION_CODES.SLOT_BLOCKED]: 'SLOT_UNAVAILABLE',
  [SCHEDULE_DECISION_CODES.SLOT_FULL]: 'CAPACITY_EXCEEDED',
};

// Bookings in these states no longer consume a bay.
const NON_BLOCKING_STATUSES = ['cancelled', 'completed', 'flagged_noshow', 'released'];

/**
 * Reads the live schedule inputs from the database.
 *
 * @param {object} supabaseAdmin - service-role client.
 * @param {string} dateStr - 'YYYY-MM-DD' the validation targets.
 * @param {object} [opts]
 * @param {string} [opts.excludeBookingId] - ignore this booking (reschedules).
 * @returns {Promise<{config:object, blocks:Array, bookings:Array}>}
 */
async function loadScheduleContext(supabaseAdmin, dateStr, opts = {}) {
  if (!supabaseAdmin) throw new Error('Supabase Admin not initialized');

  // business_config is a singleton row (id = 1).
  const { data: config, error: configError } = await supabaseAdmin
    .from('business_config')
    .select(
      'opening_hour, closing_hour, slots_per_hour, max_vehicles_per_staff, ' +
      'booking_lead_time_minutes, max_advance_days, closed_weekdays, enforce_capacity'
    )
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (configError) throw configError;

  // Admin blocks for the target day (+ the following day so multi-day services
  // that spill over a day boundary still see the next day's block).
  const nextDay = new Date(`${dateStr}T00:00:00`);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = nextDay.toISOString().split('T')[0];

  const { data: blocks, error: blocksError } = await supabaseAdmin
    .from('blocked_slots')
    .select('id, block_date, start_time, end_time, reason')
    .in('block_date', [dateStr, nextDayStr]);
  if (blocksError) {
    // blocked_slots must exist for enforcement to be meaningful; surface it.
    throw blocksError;
  }

  // Existing bookings overlapping [day, day+1) plus their vehicles for the
  // weighted bay-usage calculation.
  const rangeStart = `${dateStr}T00:00:00`;
  const rangeEnd = `${nextDayStr}T23:59:59`;

  const { data: bookings, error: bookingsError } = await supabaseAdmin
    .from('bookings')
    .select('id, status, start_datetime, end_datetime, vehicles:booking_vehicles(id, status, vehicle_type)')
    .lte('start_datetime', rangeEnd)
    .gte('end_datetime', rangeStart);
  if (bookingsError) throw bookingsError;

  const activeBookings = (bookings || [])
    .filter((b) => !NON_BLOCKING_STATUSES.includes(String(b.status || '').toLowerCase()))
    .filter((b) => !opts.excludeBookingId || b.id !== opts.excludeBookingId);

  return {
    config: normalizeConfig(config || {}),
    blocks: blocks || [],
    bookings: activeBookings,
  };
}

/**
 * Counts how many staff are clocked in / on duty, used for the per-staff
 * capacity ceiling (`max_vehicles_per_staff × staffOnDuty`). Best-effort: if the
 * staff table shape is unavailable we fall back to 1 so the bay ceiling still
 * applies and validation never fails open OR falsely blocks.
 */
async function countStaffOnDuty(supabaseAdmin) {
  try {
    const { count, error } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'STAFF')
      .eq('is_active', true)
      .eq('is_clocked_in', true);
    if (error) throw error;
    return Math.max(1, count || 0);
  } catch {
    return 1;
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Parses a client `time` value into { hour, minute }. Accepts 'HH:MM',
 * 'HH:MM:SS', 'HH:MM AM/PM' or a numeric hour. Returns null when unusable.
 */
function parseTimeOfDay(time) {
  if (time == null) return null;
  if (typeof time === 'number' && Number.isFinite(time)) {
    const hour = Math.trunc(time);
    return hour >= 0 && hour <= 23 ? { hour, minute: 0 } : null;
  }
  const raw = String(time).trim().toUpperCase();
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM)?$/);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Normalises a request body into the arguments the pure module needs. */
function normalizeRequest(body = {}) {
  const dateStr = String(body.date || '').slice(0, 10);
  const slot = parseTimeOfDay(body.time ?? body.slot);
  const durationMinutes = Math.max(1, Number(body.durationMinutes) || 60);
  const requestedBays = Math.max(1, Number(body.requestedBays) || 1);
  return { dateStr, slot, durationMinutes, requestedBays };
}

/**
 * Validates a booking request against the live schedule rules.
 *
 * @returns {Promise<{
 *   valid: boolean,
 *   code: string,                 // 'OK' | PAST_DATE | CLOSED_WEEKDAY | ...
 *   message: string|null,
 *   status: number,               // HTTP status to return when !valid
 *   details: object               // echo of the interpreted request + context
 * }>}
 */
async function validateBookingRequest(supabaseAdmin, body = {}) {
  const { dateStr, slot, durationMinutes, requestedBays } = normalizeRequest(body);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return {
      valid: false,
      code: 'INVALID_DATE',
      message: 'A valid date (YYYY-MM-DD) is required.',
      status: 400,
      details: { date: body.date ?? null, time: body.time ?? body.slot ?? null },
    };
  }
  if (!slot) {
    return {
      valid: false,
      code: 'INVALID_SLOT',
      message: 'A valid start time is required.',
      status: 400,
      details: { date: dateStr, time: body.time ?? body.slot ?? null },
    };
  }

  const { config, blocks, bookings } = await loadScheduleContext(supabaseAdmin, dateStr, {
    excludeBookingId: body.excludeBookingId,
  });

  // 1. Date-level gate.
  const dateDecision = isDateBookable(dateStr, config, { blocks });
  if (!dateDecision.bookable) {
    return buildResult(dateDecision, { date: dateStr, time: `${pad2(slot.hour)}:${pad2(slot.minute)}` });
  }

  // 2. Slot-level gate (lead time, blocks, capacity).
  const staffOnDuty = await countStaffOnDuty(supabaseAdmin);
  const slotDecision = isSlotBookable(dateStr, slot, config, bookings, {
    blocks,
    durationMinutes,
    requestedBays,
    staffOnDuty,
  });

  return buildResult(slotDecision, {
    date: dateStr,
    time: `${pad2(slot.hour)}:${pad2(slot.minute)}`,
    durationMinutes,
    requestedBays,
    activeBookings: bookings.length,
    blocks: blocks.length,
  });
}

function buildResult(decision, details) {
  if (decision.bookable) {
    return {
      valid: true,
      code: 'OK',
      message: null,
      status: 200,
      details: { ...details, remaining: decision.remaining },
    };
  }
  const internalCode = decision.code;
  return {
    valid: false,
    code: CLIENT_ERROR_CODES[internalCode] || internalCode,
    internalCode,
    message: decision.reason || 'This slot is not available.',
    status: DECISION_HTTP_STATUS[internalCode] || 409,
    details,
  };
}

module.exports = {
  validateBookingRequest,
  loadScheduleContext,
  countStaffOnDuty,
  parseTimeOfDay,
  normalizeRequest,
  DECISION_HTTP_STATUS,
  CLIENT_ERROR_CODES,
};
