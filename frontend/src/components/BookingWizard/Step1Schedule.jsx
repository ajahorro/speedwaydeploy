import React, { useState, useEffect, useCallback } from 'react';
import { Calendar as CalendarIcon, Clock, Phone, AlertCircle } from 'lucide-react';
import { getAvailableSlots } from '../../services/scheduleService';
import { supabase } from '../../lib/supabase';
import { isDateBookable } from '../../domain/schedule/rules';
import CustomCalendar from './CustomCalendar';
import { calculateBayUsage } from '../../utils/schedulingUtils';
import { sanitizeVehicleText } from '../../config/constants';

const Step1Schedule = ({ bookingData, setBookingData, activeVehicleIndex = 0, onNext, onBack, onCancel, customerDetailsLocked = false, adminMode = false }) => {
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

  // Basic validation
  const vehicle = bookingData.vehicles && bookingData.vehicles[activeVehicleIndex] ? bookingData.vehicles[activeVehicleIndex] : {};
  const allVehiclesComplete = (bookingData.vehicles || []).length > 0 && (bookingData.vehicles || []).every((item) =>
    item.type && item.brand && item.model && item.plateNumber && item.services?.length
  );
  const isValid = bookingData.date && bookingData.time && (bookingData.contactNumber || '').length >= 10 &&
    (bookingData.customerName || '').trim().length > 0 && allVehiclesComplete;

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
        supabase
          .from('business_config')
          // Include the operating-hours columns too: isDateBookable() and the
          // rules engine read is_24_7/opening_hour/closing_hour, so omitting
          // them here would let the wizard's date gate disagree with the slot
          // generator and the server validator.
          .select('opening_hour, closing_hour, is_24_7, booking_lead_time_minutes, max_advance_days, closed_weekdays, enforce_capacity, slots_per_hour, max_vehicles_per_staff')
          .maybeSingle(),
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
  }, [bookingData.date, totalDuration, bookingData.vehicles, adminMode, bookingData.time, setBookingData]); // eslint-disable-line

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
    const channel = supabase
      .channel(`slots:${bookingData.date}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, trigger)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'blocked_slots' }, trigger)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'business_config' }, trigger)
      .subscribe();
    return () => {
      clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [bookingData.date, fetchSlots]);

  const handleDateChange = (e) => {
    setBookingData({ ...bookingData, date: e.target.value });
  };

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

  const iconInputStyle = {
    ...inputStyle,
    paddingLeft: '3rem'
  };

  const today = new Date().toISOString().split('T')[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Responsive Layout Styling */}
      <style>{`
        .schedule-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 2rem;
        }
        @media (min-width: 800px) {
          .schedule-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
      `}</style>

      <div>
        <h2 style={{ margin: '0 0 0.5rem 0', fontSize: '1.5rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>Select Schedule</h2>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.9rem', fontWeight: '600' }}>
          Choose your preferred date and time. Full slots are filtered using the shop's configured bay capacity and staff limit.
        </p>
      </div>

      <div className="schedule-grid">

        {/* Left Col: Contact & Date */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-lg)', padding: 'clamp(1rem, 3vw, 1.5rem)', boxShadow: 'var(--admin-card-shadow)' }}>

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

          <div>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Active Contact Number
            </label>
            <div style={{ position: 'relative' }}>
              <Phone size={18} color="var(--admin-brand)" style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)' }} />
              <input
                type="tel"
                value={bookingData.contactNumber}
                disabled={customerDetailsLocked}
                onChange={(e) => setBookingData({ ...bookingData, contactNumber: e.target.value.replace(/\D/g, '').slice(0, 15) })}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--admin-brand)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--admin-input-border)'; }}
                style={iconInputStyle}
                placeholder="e.g. 09123456789"
              />
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Select Date
            </label>
            <CustomCalendar
              selectedDate={bookingData.date}
              onDateSelect={(date) => setBookingData({ ...bookingData, date })}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Special Instructions / Notes (Optional)
            </label>
            <textarea
              value={bookingData.notes || ''}
              onChange={(e) => setBookingData({ ...bookingData, notes: sanitizeVehicleText(e.target.value) })}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--admin-brand)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--admin-input-border)'; }}
              placeholder="e.g. Please take extra care of the leather seats..."
              style={{ ...inputStyle, minHeight: '100px', resize: 'none' }}
            />
          </div>

        </div>

        {/* Right Col: Time Slots & Vehicle Details */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-lg)', padding: 'clamp(1rem, 3vw, 1.5rem)', boxShadow: 'var(--admin-card-shadow)' }}>

          {/* Time Slots Section */}
          <div>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Available Time Slots
            </label>

            {!bookingData.date ? (
              <div style={{ background: 'var(--admin-bg)', border: '1px dashed var(--admin-border)', borderRadius: 'var(--admin-radius-md)', padding: '2rem', textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.9rem', fontWeight: '600' }}>
                Please select a date first to view available slots.
              </div>
            ) : isLoadingSlots ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--admin-brand)', fontWeight: '900' }}>
                Checking bay capacity...
              </div>
            ) : availableSlots.length === 0 ? (
              <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 'var(--admin-radius-md)', padding: '1.5rem', color: 'var(--status-danger)', display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: '600', fontSize: '0.9rem' }}>
                <AlertCircle size={20} style={{ flexShrink: 0 }} />
                <span>
                  {dateGate && !dateGate.bookable
                    ? `${dateGate.reason} Please choose another date.`
                    : 'No matching time slots are available for this fleet. Try another date or a shorter service selection.'}
                </span>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(135px, 1fr))', gap: '0.75rem' }}>
                {availableSlots.map(slot => (
                  <button
                    key={slot.time}
                    onClick={() => handleTimeSelect(slot.time)}
                    className="admin-card-hover"
                    style={{
                      padding: '0.75rem 0.5rem',
                      background: bookingData.time === slot.time ? 'var(--admin-brand)' : 'var(--admin-input-bg)',
                      color: bookingData.time === slot.time ? '#fff' : 'var(--admin-text-primary)',
                      border: `1px solid ${bookingData.time === slot.time ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                      borderRadius: 'var(--admin-radius-md)',
                      cursor: 'pointer',
                      fontWeight: '900',
                      fontSize: '0.9rem',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}><Clock size={15} /> {slot.time}</span>
                    <small style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.65rem', fontWeight: '700', opacity: bookingData.time === slot.time ? 0.9 : 0.7 }}>{slot.availableBays} capacity slot{slot.availableBays === 1 ? '' : 's'} available</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action Footer */}
      <div style={{ 
        display: 'flex', 
        flexWrap: 'wrap', 
        gap: '1rem', 
        justifyContent: 'space-between', 
        borderTop: '1px solid var(--admin-border)', 
        paddingTop: '1.5rem', 
        marginTop: '1rem' 
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
