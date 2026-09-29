import React, { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, AlertCircle, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { isDateBookable } from '../../domain/schedule/rules';

// ─── helpers ───────────────────────────────────────────────────────────────

function toDateString(dateObj) {
  const yyyy = dateObj.getFullYear();
  const mm   = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd   = String(dateObj.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getCapacityColor(bays) {
  if (bays >= 4) return '#10b981';
  if (bays >= 2) return '#f59e0b';
  return '#ef4444';
}

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

// ─── InlineCalendar ─────────────────────────────────────────────────────────
// Lifted directly from CustomCalendar.jsx logic — no logic changes.

function InlineCalendar({ selectedDate, onDateSelect, config = null, blocks = null }) {
  const [currentDate, setCurrentDate] = useState(() => {
    if (selectedDate) {
      const [y, m] = selectedDate.split('-').map(Number);
      return new Date(y, m - 1, 1);
    }
    return new Date();
  });
  const [localConfig, setLocalConfig] = useState(config);
  const [localBlocks, setLocalBlocks] = useState(blocks);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const year  = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // Load config + blocks when the caller did not provide them.
  useEffect(() => {
    if (config && blocks) return;
    let cancelled = false;
    (async () => {
      try {
        const [configRes, blockRes] = await Promise.all([
          supabase
            .from('business_config')
            .select('opening_hour, closing_hour, is_24_7, booking_lead_time_minutes, max_advance_days, closed_weekdays, enforce_capacity, slots_per_hour, max_vehicles_per_staff')
            .maybeSingle(),
          supabase.from('blocked_slots').select('block_date, start_time, end_time'),
        ]);
        if (cancelled) return;
        if (!config) setLocalConfig(configRes.data || {});
        if (!blocks) setLocalBlocks(blockRes.data || []);
      } catch (err) {
        console.warn('Calendar schedule rules unavailable:', err?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [config, blocks]);

  const daysInMonth    = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();

  // Build cell list
  const cells = [];
  for (let i = 0; i < firstDayOfMonth; i++) {
    cells.push(<div key={`empty-${i}`} />);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj    = new Date(year, month, day);
    const dateString = toDateString(dateObj);
    const isSelected = selectedDate === dateString;
    const isToday    = toDateString(today) === dateString;
    const decision   = isDateBookable(dateString, localConfig || {}, { blocks: localBlocks || [] });
    const isDisabled = !decision.bookable;
    const tooltip    = isDisabled
      ? (decision.reason || 'This date cannot be booked.')
      : `Book on ${MONTH_NAMES[month]} ${day}`;

    cells.push(
      <button
        key={day}
        type="button"
        onClick={() => { if (!isDisabled) onDateSelect(dateString); }}
        disabled={isDisabled}
        title={tooltip}
        aria-label={`${dateString}${isDisabled ? ` — unavailable: ${tooltip}` : ''}`}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          aspectRatio: '1 / 1',
          borderRadius: '50%',
          border: isToday && !isSelected ? '1.5px solid var(--admin-brand)' : '1.5px solid transparent',
          background: isSelected ? 'var(--admin-brand)' : 'transparent',
          color: isDisabled
            ? 'rgba(255,255,255,0.18)'
            : isSelected
            ? '#fff'
            : 'var(--admin-text-primary)',
          fontWeight: isSelected || isToday ? '900' : '500',
          fontSize: 'clamp(0.72rem, 2vw, 0.88rem)',
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s ease, color 0.15s ease',
          outline: 'none',
          minWidth: 0,
          padding: 0,
        }}
        onMouseEnter={(e) => {
          if (!isDisabled && !isSelected) {
            e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isDisabled && !isSelected) {
            e.currentTarget.style.background = 'transparent';
          }
        }}
      >
        {day}
      </button>
    );
  }

  return (
    <div>
      {/* Month nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <button
          type="button"
          onClick={() => setCurrentDate(new Date(year, month - 1, 1))}
          aria-label="Previous month"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--admin-border)', borderRadius: '50%', width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-primary)', cursor: 'pointer', flexShrink: 0 }}
        >
          <ChevronLeft size={15} />
        </button>

        <span style={{ fontWeight: '900', fontSize: 'clamp(0.85rem, 2.5vw, 1rem)', color: 'var(--admin-text-primary)', letterSpacing: '0.5px' }}>
          {MONTH_NAMES[month]} {year}
        </span>

        <button
          type="button"
          onClick={() => setCurrentDate(new Date(year, month + 1, 1))}
          aria-label="Next month"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--admin-border)', borderRadius: '50%', width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-primary)', cursor: 'pointer', flexShrink: 0 }}
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Day-of-week headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', marginBottom: '0.35rem' }}>
        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
          <div key={d} style={{ fontSize: '0.68rem', fontWeight: '700', color: 'var(--admin-text-secondary)', padding: '0.2rem 0' }}>
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
        {cells}
      </div>
    </div>
  );
}

// ─── SlotList ────────────────────────────────────────────────────────────────
// Pure 2-column grid of pill rows, no grouping accordion (reference image style).

function SlotList({ slots, selectedTime, onSelect, isLoading, selectedDate, dateGate }) {
  if (!selectedDate) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', height: '100%', minHeight: '120px', color: 'var(--admin-text-secondary)', fontSize: '0.82rem', fontWeight: '600', textAlign: 'center', opacity: 0.7 }}>
        <span style={{ fontSize: '1.5rem' }}>📅</span>
        Pick a date to see available slots
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', height: '120px', color: 'var(--admin-brand)', fontWeight: '900', fontSize: '0.82rem' }}>
        <Loader2 size={16} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
        Checking bay capacity…
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', padding: '1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '10px', color: 'var(--status-danger)', fontSize: '0.8rem', fontWeight: '700' }}>
        <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
        <span>
          {dateGate && !dateGate.bookable
            ? `${dateGate.reason} Please choose another date.`
            : 'No available time slots for this date. Try another date or adjust your service selection.'}
        </span>
      </div>
    );
  }

  // Pair up slots into rows of 2 for the reference-image layout
  const pairs = [];
  for (let i = 0; i < slots.length; i += 2) {
    pairs.push([slots[i], slots[i + 1] || null]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .dtp-slot-btn {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.4rem;
          width: 100%;
          padding: 0.65rem 0.9rem;
          border-radius: 8px;
          border: 1px solid transparent;
          cursor: pointer;
          font-size: 0.82rem;
          font-weight: 700;
          transition: background 0.12s ease, border-color 0.12s ease;
          outline: none;
          box-sizing: border-box;
          text-align: left;
          background: rgba(255,255,255,0.04);
          color: var(--admin-text-primary);
        }
        .dtp-slot-btn:hover:not(.dtp-slot-selected) {
          background: rgba(255,255,255,0.09);
          border-color: var(--admin-border);
        }
        .dtp-slot-selected {
          background: var(--admin-brand) !important;
          border-color: var(--admin-brand) !important;
          color: #fff !important;
        }
        .dtp-slot-badge {
          font-size: 0.6rem;
          font-weight: 800;
          border-radius: 999px;
          padding: 0.08rem 0.4rem;
          white-space: nowrap;
          flex-shrink: 0;
        }
      `}</style>

      {pairs.map((pair, idx) => (
        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem' }}>
          {pair.map((slot, si) => {
            if (!slot) return <div key={si} />;
            const isSel = selectedTime === slot.time;
            const capColor = getCapacityColor(slot.availableBays);
            return (
              <button
                key={slot.time}
                type="button"
                onClick={() => onSelect(slot.time)}
                className={`dtp-slot-btn${isSel ? ' dtp-slot-selected' : ''}`}
              >
                <span>{slot.time}</span>
                <span
                  className="dtp-slot-badge"
                  style={{
                    background: isSel ? 'rgba(255,255,255,0.2)' : `${capColor}20`,
                    color: isSel ? 'rgba(255,255,255,0.9)' : capColor,
                    border: `1px solid ${isSel ? 'rgba(255,255,255,0.3)' : `${capColor}50`}`,
                  }}
                >
                  {slot.availableBays}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── DateTimePicker ──────────────────────────────────────────────────────────

/**
 * DateTimePicker
 *
 * Props:
 *   selectedDate  : string (YYYY-MM-DD)
 *   onDateSelect  : (date: string) => void
 *   slots         : { hour, minute, time, availableBays }[]
 *   selectedTime  : string
 *   onTimeSelect  : (time: string) => void
 *   isLoadingSlots: boolean
 *   dateGate      : { bookable: boolean, reason: string } | null
 *
 * Layout:
 *   Mobile  (<700 px): calendar on top, slots below (scrollable)
 *   Desktop (≥700 px): calendar on left, slots on right (side by side)
 */
export default function DateTimePicker({
  selectedDate,
  onDateSelect,
  slots = [],
  selectedTime,
  onTimeSelect,
  isLoadingSlots = false,
  dateGate = null,
}) {
  return (
    <div className="dtp-root" style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-lg)', overflow: 'hidden', boxShadow: 'var(--admin-card-shadow)' }}>
      <style>{`
        .dtp-root {
          display: flex;
          flex-direction: column;
        }
        @media (min-width: 700px) {
          .dtp-root {
            flex-direction: row;
          }
          .dtp-calendar-pane {
            flex: 0 0 320px;
            border-right: 1px solid var(--admin-border) !important;
            border-bottom: none !important;
          }
          .dtp-slots-pane {
            flex: 1 1 0;
          }
        }
        .dtp-calendar-pane {
          padding: clamp(1rem, 3vw, 1.5rem);
          border-bottom: 1px solid var(--admin-border);
          background: rgba(0,0,0,0.15);
        }
        .dtp-slots-pane {
          padding: clamp(1rem, 3vw, 1.5rem);
          overflow-y: auto;
          max-height: 420px;
        }
        @media (min-width: 700px) {
          .dtp-slots-pane {
            max-height: 440px;
          }
        }
      `}</style>

      {/* Left / Top — Calendar */}
      <div className="dtp-calendar-pane">
        <div style={{ fontSize: '0.62rem', fontWeight: '900', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.75rem' }}>
          Select Date
        </div>
        <InlineCalendar
          selectedDate={selectedDate}
          onDateSelect={onDateSelect}
        />
      </div>

      {/* Right / Bottom — Time slots */}
      <div className="dtp-slots-pane">
        <div style={{ fontSize: '0.62rem', fontWeight: '900', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.75rem' }}>
          {selectedDate
            ? `Available Times — ${new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' })}`
            : 'Available Times'}
        </div>
        <SlotList
          slots={slots}
          selectedTime={selectedTime}
          onSelect={onTimeSelect}
          isLoading={isLoadingSlots}
          selectedDate={selectedDate}
          dateGate={dateGate}
        />
      </div>
    </div>
  );
}
