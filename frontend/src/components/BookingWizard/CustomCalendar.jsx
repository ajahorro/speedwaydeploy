import React, { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { isDateBookable } from '../../domain/schedule/rules';

/**
 * CustomCalendar
 * ============================================================================
 * Batch 6 / Step 6.4 — schedule-rule-aware date picker.
 *
 * Unbookable days are greyed out and disabled, with a tooltip explaining WHY
 * (past date, closed weekday, blocked date, beyond the advance window). The
 * decision comes from the shared pure rules module (`isDateBookable`), so the
 * calendar can never disagree with the server-side validator.
 *
 * `config` and `blocks` may be passed in by a parent that already loaded them;
 * when omitted the component loads `business_config` + `blocked_slots` itself,
 * so existing callers get the behaviour without any wiring changes.
 */
const CustomCalendar = ({ selectedDate, onDateSelect, config = null, blocks = null }) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [localConfig, setLocalConfig] = useState(config);
  const [localBlocks, setLocalBlocks] = useState(blocks);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // Load the schedule rules + admin blocks when the caller did not provide them.
  useEffect(() => {
    if (config && blocks) return;
    let cancelled = false;
    (async () => {
      try {
        const [configRes, blockRes] = await Promise.all([
          supabase
            .from('business_config')
            .select('booking_lead_time_minutes, max_advance_days, closed_weekdays, enforce_capacity, slots_per_hour, max_vehicles_per_staff')
            .maybeSingle(),
          supabase
            .from('blocked_slots')
            .select('block_date, start_time, end_time'),
        ]);
        if (cancelled) return;
        if (!config) setLocalConfig(configRes.data || {});
        if (!blocks) setLocalBlocks(blockRes.data || []);
      } catch (err) {
        // Non-fatal: without config the calendar falls back to the rules module's
        // safe defaults (past-date-only greying).
        console.warn('Calendar schedule rules unavailable:', err?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [config, blocks]);

  const handlePrevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const toDateString = (dateObj) => {
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const handleDayClick = (day, disabled) => {
    if (disabled) return;
    onDateSelect(toDateString(new Date(year, month, day)));
  };

  const days = [];
  for (let i = 0; i < firstDayOfMonth; i++) {
    days.push(<div key={`empty-${i}`} style={{ padding: '0.5rem' }} />);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(year, month, day);
    const dateString = toDateString(dateObj);
    const isSelected = selectedDate === dateString;

    // Single source of truth: the pure rules module decides bookability.
    const decision = isDateBookable(dateString, localConfig || {}, { blocks: localBlocks || [] });
    const isDisabled = !decision.bookable;
    const tooltip = isDisabled
      ? decision.reason || 'This date cannot be booked.'
      : `Book on ${monthNames[month]} ${day}`;

    days.push(
      <button
        key={day}
        type="button"
        onClick={() => handleDayClick(day, isDisabled)}
        disabled={isDisabled}
        title={tooltip}
        aria-label={`${dateString}${isDisabled ? ` — unavailable: ${tooltip}` : ''}`}
        style={{
          padding: '0.75rem 0',
          background: isSelected ? 'var(--admin-brand)' : 'transparent',
          color: isDisabled ? 'var(--admin-text-secondary)' : isSelected ? '#fff' : 'var(--admin-text-primary)',
          border: '1px solid',
          borderColor: isSelected ? 'var(--admin-brand)' : 'transparent',
          borderRadius: 'var(--admin-radius-sm)',
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.3 : 1,
          fontWeight: isSelected ? '900' : '600',
          transition: 'all 0.2s ease',
          outline: 'none'
        }}
        onMouseEnter={(e) => {
          if (!isDisabled && !isSelected) {
            e.target.style.background = 'var(--admin-bg)';
            e.target.style.borderColor = 'var(--admin-border)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isDisabled && !isSelected) {
            e.target.style.background = 'transparent';
            e.target.style.borderColor = 'transparent';
          }
        }}
      >
        {day}
      </button>
    );
  }

  return (
    <div style={{ background: 'transparent', padding: '0.25rem 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <button 
          type="button"
          onClick={handlePrevMonth}
          aria-label="Previous month"
          style={{ background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-primary)', cursor: 'pointer' }}
        >
          <ChevronLeft size={16} />
        </button>
        <div style={{ fontWeight: '900', textTransform: 'uppercase', letterSpacing: '1px', fontSize: '1rem', color: 'var(--admin-text-primary)' }}>
          {monthNames[month]} {year}
        </div>
        <button
          type="button"
          onClick={handleNextMonth}
          aria-label="Next month"
          style={{ background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-primary)', cursor: 'pointer' }}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Weekdays */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '0.25rem', marginBottom: '0.5rem', textAlign: 'center' }}>
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => (
          <div key={d} style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>
            {d}
          </div>
        ))}
      </div>

      {/* Days Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '0.25rem' }}>
        {days}
      </div>
    </div>
  );
};

export default CustomCalendar;
