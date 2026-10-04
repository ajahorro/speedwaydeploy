import React, { useState, useEffect, useCallback } from 'react';
import { Phone } from 'lucide-react';
import { getAvailableSlots } from '../../services/scheduleService';
import { supabase } from '../../lib/supabase';
import { subscribeTables } from '../../lib/realtimeHub';
import { isDateBookable } from '../../domain/schedule/rules';
import { calculateBayUsage } from '../../utils/schedulingUtils';
import { sanitizeVehicleText } from '../../config/constants';
import DateTimePicker from './DateTimePicker';
import { ensureShopConfig } from '../../config/shopConfig';
import { PhoneInput } from '../common/ContactInputs';
import { isValidPhPhone } from '../../utils/contactValidation';

const Step1Schedule = ({ bookingData, setBookingData, activeVehicleIndex = 0, onNext, onBack, onCancel, customerDetailsLocked = false, adminMode = false, selectedCustomerId = null }) => {
  const [availableSlots, setAvailableSlots] = useState([]);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  // Batch 6: why the selected date itself may be unbookable (closed/blocked/etc),
  // loaded from the shared rules engine so the message matches the server.
  const [dateGate, setDateGate] = useState(null);

  // Vehicles are serviced concurrently; duration is driven by the longest unit,
  // while bay capacity separately limits how many units can share the slot.
  const totalDuration = ((bookingData.vehicles || []).reduce((longest, vehicle) => Math.max(
    longest,
    (vehicle.services || []).reduce((sum, service) => sum + Number(service.durationMinutes || 60), 0)
  ), 0) || 60) + 60;
  const hasSelectedExistingCustomer = adminMode && Boolean(selectedCustomerId || bookingData.customerId);
  const showEditableCustomerDetails = !hasSelectedExistingCustomer;

  // Basic validation
  const allVehiclesComplete = (bookingData.vehicles || []).length > 0 && (bookingData.vehicles || []).every((item) =>
    item.type && item.brand && item.model && item.plateNumber && item.services?.length
  );
  const customerDetailsComplete = hasSelectedExistingCustomer || (
    isValidPhPhone(bookingData.contactNumber) && (bookingData.customerName || '').trim().length > 0
  );
  const isValid = Boolean(bookingData.date && bookingData.time && customerDetailsComplete && allVehiclesComplete);

  // Fetch available slots when date changes (real bay capacity check)
  const fetchSlots = useCallback(async (silent = false) => {
    if (!bookingData.date) return;
    if (!silent) setIsLoadingSlots(true);
    try {
      const requestedBays = Math.max(1, calculateBayUsage(bookingData.vehicles || []));

      // The slot list itself now comes from the shared rules engine (via
      // scheduleService), so lead time greys out early same-day slots here
      // instead of only rejecting them at submit. We only fetch the config +
      // blocks here to explain WHY the whole day is unavailable.
      const [configRes, blockRes, slots] = await Promise.all([
        // The shop configuration row (single reader: config/shopConfig.js), so the
        // date gate, the slot generator and the server use the same rules.
        ensureShopConfig().then((data) => ({ data, error: null }), (error) => ({ data: null, error })),
        supabase
          .from('blocked_slots')
          .select('block_date, start_time, end_time')
          .eq('block_date', bookingData.date),
        getAvailableSlots(bookingData.date, totalDuration, bookingData.vehicles || [], null, { requestedBays, skipLeadTime: adminMode }),
      ]);
      const gate = isDateBookable(bookingData.date, configRes.data || {}, { blocks: blockRes.data || [] });
      setDateGate(gate);

      setAvailableSlots(slots);

      // Auto-clear time if the selected time is no longer available
      if (bookingData.time && !slots.some(slot => slot.time === bookingData.time)) {
        setBookingData(prev => ({ ...prev, time: '' }));
      }
    } catch (error) {
      console.error('Failed to fetch slots', error);
    } finally {
      if (!silent) setIsLoadingSlots(false);
    }
  }, [bookingData.date, totalDuration, bookingData.vehicles, adminMode, bookingData.time, setBookingData]);

  // Recompute on date / duration / vehicle / mode change.
  useEffect(() => {
    fetchSlots(false);
  }, [fetchSlots]);

  // LIVE SLOT REFLECTION: subscribe to the tables that can change what is
  // bookable while the user is on this screen (a slot gets taken, an admin
  // blocks/opens a day, business hours change). On any change we silently
  // recompute the slot list so it reflects reality within ~1s instead of only
  // refreshing on the next date change — and the auto-clear above drops a chosen
  // time that has just been booked by someone else.
  useEffect(() => {
    if (!bookingData.date) return undefined;
    let debounce;
    const trigger = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => fetchSlots(true), 600);
    };
    const stopRealtime = subscribeTables(
      [{ table: 'bookings' }, { table: 'blocked_slots' }, { table: 'business_config' }],
      trigger
    );
    return () => {
      clearTimeout(debounce);
      stopRealtime();
    };
  }, [bookingData.date, fetchSlots]);

  const handleTimeSelect = (time) => {
    setBookingData({ ...bookingData, time });
  };

  const handleVehicleChange = (field, value) => {
    const updatedVehicles = [...(bookingData.vehicles || [])];
    if (!updatedVehicles[activeVehicleIndex]) {
      updatedVehicles[activeVehicleIndex] = { id: crypto.randomUUID(), type: '', brand: '', model: '', plateNumber: '', services: [] };
    }
    // Clear services if the type is changing
    if (field === 'type' && updatedVehicles[activeVehicleIndex].type !== value) {
      updatedVehicles[activeVehicleIndex] = { ...updatedVehicles[activeVehicleIndex], [field]: value, services: [] };
    } else {
      updatedVehicles[activeVehicleIndex] = { ...updatedVehicles[activeVehicleIndex], [field]: value };
    }

    setBookingData({ ...bookingData, vehicles: updatedVehicles });
  };

  const inputStyle = {
    width: '100%',
    background: 'var(--admin-input-bg)',
    border: '1px solid var(--admin-input-border)',
    padding: '0.85rem 1rem',
    borderRadius: '8px',
    color: 'var(--admin-text-primary)',
    fontSize: '0.95rem',
    fontWeight: '800',
    outline: 'none',
    boxSizing: 'border-box'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>

      {/* Page Title */}
      <div>
        <h2 style={{ margin: '0 0 0.4rem 0', fontSize: '1.5rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>Select Schedule</h2>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.9rem', fontWeight: '600' }}>
          Choose your preferred date and time. Full slots are filtered using the shop's configured bay capacity and staff limit.
        </p>
      </div>

      {/* Contact Details */}
      <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-lg)', padding: 'clamp(1rem, 3vw, 1.5rem)', boxShadow: 'var(--admin-card-shadow)', display: 'grid', gap: '1.25rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {showEditableCustomerDetails && (
          <>
            {/* Full Name */}
            <div>
              <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Full Name
              </label>
              <input
                type="text"
                value={bookingData.customerName || ''}
                disabled={customerDetailsLocked}
                onChange={(e) => setBookingData({ ...bookingData, customerName: sanitizeVehicleText(e.target.value) })}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--admin-brand)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--admin-input-border)'; }}
                style={inputStyle}
                placeholder="e.g. John Doe"
              />
            </div>

            {/* Contact Number */}
            <div>
              <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Active Contact Number
              </label>
              <div style={{ position: 'relative' }}>
                <Phone size={18} color="var(--admin-brand)" style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)' }} />
                <PhoneInput
                  aria-label="Active contact number"
                  value={bookingData.contactNumber || ''}
                  disabled={customerDetailsLocked}
                  onChange={(e) => setBookingData({ ...bookingData, contactNumber: e.target.value })}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--admin-brand)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--admin-input-border)'; }}
                  style={{ ...inputStyle, paddingLeft: '3rem' }}
                  placeholder="e.g. 09123456789"
                  required={false}
                />
              </div>
            </div>
          </>
        )}

        {/* Notes — full width */}
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Special Instructions / Notes (Optional)
          </label>
          <textarea
            value={bookingData.notes || ''}
            onChange={(e) => setBookingData({ ...bookingData, notes: sanitizeVehicleText(e.target.value) })}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--admin-brand)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--admin-input-border)'; }}
            placeholder="e.g. Please take extra care of the leather seats..."
            style={{ ...inputStyle, minHeight: '80px', resize: 'none' }}
          />
        </div>
      </div>

      {/* ── Unified Date + Time Picker ─────────────────────────────────────── */}
      <DateTimePicker
        selectedDate={bookingData.date}
        onDateSelect={(date) => setBookingData({ ...bookingData, date, time: '' })}
        slots={availableSlots}
        selectedTime={bookingData.time}
        onTimeSelect={handleTimeSelect}
        isLoadingSlots={isLoadingSlots}
        dateGate={dateGate}
      />

      {/* Action Footer */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '1rem',
        justifyContent: 'space-between',
        borderTop: '1px solid var(--admin-border)',
        paddingTop: '1.5rem',
        marginTop: '0.25rem'
      }}>
        <button
          onClick={onBack}
          style={{
            flex: '1 1 150px',
            padding: '1rem 2rem',
            background: 'var(--admin-bg)',
            color: 'var(--admin-text-primary)',
            border: '1px solid var(--admin-border)',
            borderRadius: 'var(--admin-radius-md)',
            fontWeight: '950',
            fontSize: '1rem',
            cursor: 'pointer',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            textAlign: 'center'
          }}
        >
          Back: Adjust Services
        </button>

        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              flex: '1 1 150px',
              background: 'transparent',
              border: '1px solid #ef4444',
              color: 'var(--status-danger)',
              padding: '1rem 2rem',
              borderRadius: 'var(--admin-radius-md)',
              fontWeight: '950',
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '1px',
              textAlign: 'center'
            }}
          >
            Cancel Booking
          </button>
        )}

        <button
          onClick={onNext}
          disabled={!isValid}
          style={{
            flex: '1 1 150px',
            padding: '1rem 2rem',
            background: isValid ? 'var(--admin-brand)' : 'var(--admin-bg)',
            color: isValid ? '#fff' : 'var(--admin-text-secondary)',
            border: `1px solid ${isValid ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
            borderRadius: 'var(--admin-radius-md)',
            fontWeight: '950',
            fontSize: '1rem',
            cursor: isValid ? 'pointer' : 'not-allowed',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            transition: 'all 0.3s ease',
            textAlign: 'center'
          }}
        >
          Next: Fleet Editing
        </button>
      </div>

    </div>
  );
};

export default Step1Schedule;
