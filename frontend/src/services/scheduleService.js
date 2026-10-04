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
 * Occupancy of every booking overlapping [startIso, endIso): times, status and
 * per-vehicle type/status only. Customers cannot SELECT other customers'
 * bookings under RLS, so capacity checks go through this SECURITY DEFINER RPC,
 * which returns no booking id, customer, staff, amount or plate.
 *
 * Throws on failure so callers fail closed instead of treating an unreadable
 * schedule as an empty one (which would offer slots that are already full).
 */
export const fetchScheduleOccupancy = async (startIso, endIso, excludedBookingId = null) => {
  const { data, error } = await supabase.rpc('get_schedule_occupancy', {
    p_start: startIso,
    p_end: endIso,
    p_exclude_booking_id: excludedBookingId,
  });
  if (error) throw error;
  return data || [];
};

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
    const baseDay = new Date(`${dateStr}T00:00:00Z`);
    const dayKeys = [];
    for (let i = 0; i <= spanDays; i += 1) {
      const d = new Date(baseDay);
      d.setUTCDate(d.getUTCDate() + i);
      dayKeys.push(d.toISOString().split('T')[0]);
    }

    const [configRes, blocksRes] = await Promise.all([
      supabase
        .from('business_config')
        .select('opening_hour, closing_hour, is_24_7, slots_per_hour, booking_lead_time_minutes, max_advance_days, closed_weekdays, enforce_capacity')
        .order('id')
        .limit(1)
        .maybeSingle(),
      supabase
        .from('blocked_slots')
        .select('block_date, start_time, end_time')
        .in('block_date', dayKeys),
    ]);
    const config = configRes.data || {};
    const blocks = blocksRes.data || [];

    // 2. Load existing bookings overlapping the requested window. Multi-day
    //    services can spill past midnight, so we widen the range by day count.
    const startOfDay = `${dateStr}T00:00:00+08:00`;
    const checkDateEnd = new Date(`${dateStr}T00:00:00Z`);
    checkDateEnd.setUTCDate(checkDateEnd.getUTCDate() + Math.ceil(durationMinutes / 1440) + 1);
    const endOfRange = `${checkDateEnd.toISOString().split('T')[0]}T23:59:59+08:00`;

    //    The booking being rescheduled is excluded server-side so it never
    //    blocks its own new slot.
    const bookings = await fetchScheduleOccupancy(startOfDay, endOfRange, excludedBookingId);

    // Preserve the historical purge of stale 'scheduled' sessions.
    const activeBookings = filterActiveBookings(bookings);

    // 3. Single source of truth: the pure rules engine decides every slot.
    const slots = getBookableSlots(dateStr, config, activeBookings, {
      blocks,
      durationMinutes,
      requestedBays,
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
