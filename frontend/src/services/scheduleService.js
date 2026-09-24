import { supabase } from '../lib/supabase';
import { logger } from '../utils/logger';
import { filterActiveBookings, formatDisplayTime } from '../utils/schedulingUtils';
import { getBookableSlots } from '../domain/schedule/rules';

/**
 * scheduleService.js
 * Handles bay capacity checks and slot availability for booking wizard.
 *
 * UNIFICATION (this revision): every slot decision in the app — the customer
 * booking wizard, the customer + admin reschedule modals, and the backend
 * validator — is produced by ONE calculator: the pure rules module at
 * `domain/schedule/rules.js`. This file no longer re-implements capacity, lead
 * time, business hours, or block handling; it only loads the DB rows the rules
 * module needs and adapts the result to the UI shape the callers expect.
 */

/**
 * Returns the bookable start slots for a date, computed by the shared rules
 * engine. Output shape is preserved for existing UI callers:
 *   [{ hour, minute, time: 'HH:MM AM', availableBays }]
 *
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @param {number} [requestedDuration] - service duration in minutes
 * @param {Array}  [requestedVehicles] - vehicles in the booking (bay weighting)
 * @param {string|null} [excludedBookingId] - ignore this booking (reschedules)
 * @param {object} [options]
 * @param {number} [options.requestedBays] - bays this booking needs (default 1)
 * @param {number} [options.staffOnDuty] - staff available (per-staff ceiling)
 * @param {boolean} [options.skipLeadTime] - admin/desk path: ignore the
 *   customer-facing minimum advance notice (customer is already on site).
 */
export const getAvailableSlots = async (dateStr, requestedDuration = 60, requestedVehicles = [], excludedBookingId = null, options = {}) => {
  try {
    const durationMinutes = Math.max(1, Number(requestedDuration) || 60);
    const requestedBays = Math.max(1, Number(options.requestedBays) || 1);

    // 1. Load business hours/capacity + admin blocks for EVERY day the service
    //    spans (a midnight-crossing or multi-day job must see later days' blocks).
    const spanDays = Math.max(1, Math.ceil(durationMinutes / 1440));
    const baseDay = new Date(`${dateStr}T00:00:00`);
    const dayKeys = [];
    for (let i = 0; i <= spanDays; i += 1) {
      const d = new Date(baseDay);
      d.setDate(d.getDate() + i);
      dayKeys.push(d.toISOString().split('T')[0]);
    }

    // SP-1: the per-staff ceiling (business_config.max_vehicles_per_staff x staff
    // on duty) was silently multiplying by a hard-coded 1, because NO caller ever
    // passed `staffOnDuty`. We resolve it here, once, so every consumer of this
    // service — the booking wizard, the customer reschedule modal and the admin
    // reschedule modal — gets the real headcount without each having to remember.
    //
    // The definition MUST match backend/services/scheduleValidation.js
    // countStaffOnDuty(): active STAFF profiles that are clocked in, floored at 1.
    // Divergence here would reintroduce exactly the client/server disagreement
    // this pass exists to remove.
    const [configRes, blocksRes, staffRes] = await Promise.all([
      supabase
        .from('business_config')
        .select('opening_hour, closing_hour, is_24_7, slots_per_hour, max_vehicles_per_staff, booking_lead_time_minutes, max_advance_days, closed_weekdays, enforce_capacity')
        .order('id')
        .limit(1)
        .maybeSingle(),
      supabase
        .from('blocked_slots')
        .select('block_date, start_time, end_time')
        .in('block_date', dayKeys),
      supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'STAFF')
        .eq('is_active', true)
        .eq('is_clocked_in', true),
    ]);
    const config = configRes.data || {};
    const blocks = blocksRes.data || [];
    // Best-effort: a missing/denied staff read must never block the calendar, so
    // fall back to the caller's value, then to 1 (the previous behaviour).
    const staffCount = Number(staffRes?.count);
    const staffOnDuty = Number.isFinite(staffCount) && staffCount > 0
      ? staffCount
      : (Number(options.staffOnDuty) > 0 ? Number(options.staffOnDuty) : 1);

    // 2. Load existing bookings overlapping the requested window. Multi-day
    //    services can spill past midnight, so we widen the range by day count.
    const startOfDay = `${dateStr}T00:00:00`;
    const checkDateEnd = new Date(dateStr);
    checkDateEnd.setDate(checkDateEnd.getDate() + Math.ceil(durationMinutes / 1440) + 1);
    const endOfRange = `${checkDateEnd.toISOString().split('T')[0]}T23:59:59`;

    const { data: bookings } = await supabase
      .from('bookings')
      .select('id, start_datetime, end_datetime, status, vehicles:booking_vehicles(id, status, vehicle_type)')
      .lte('start_datetime', endOfRange)
      .gte('end_datetime', startOfDay);

    // Preserve the historical purge of stale 'scheduled' sessions, then exclude
    // the booking being rescheduled so it never blocks its own new slot.
    const activeBookings = filterActiveBookings(bookings || [])
      .filter((b) => b.id !== excludedBookingId);

    // 3. Single source of truth: the pure rules engine decides every slot.
    const slots = getBookableSlots(dateStr, config, activeBookings, {
      blocks,
      durationMinutes,
      requestedBays,
      // SP-1: pass the real headcount so max_vehicles_per_staff is honoured.
      staffOnDuty,
      skipLeadTime: options.skipLeadTime,
    });

    return slots.map((slot) => ({
      hour: slot.hour,
      minute: slot.minute,
      time: formatDisplayTime(slot.hour, slot.minute),
      availableBays: slot.remaining,
    }));
  } catch (err) {
    logger.error('Schedule Service Error', err);
    return [];
  }
};

/**
 * Fetch business operating hours from business_config.
 * Can be used to dynamically generate slot ranges.
 */
export const getBusinessHours = async () => {
  const { data, error } = await supabase
    .from('business_config')
    .select('opening_hour, closing_hour, is_24_7')
    .maybeSingle();

  if (error || !data) return { opening: '08:00 AM', closing: '06:00 PM', is24_7: false };
  if (data.is_24_7 === true) return { opening: '12:00 AM', closing: '12:00 AM', is24_7: true };
  return { opening: data.opening_hour, closing: data.closing_hour, is24_7: false };
};
