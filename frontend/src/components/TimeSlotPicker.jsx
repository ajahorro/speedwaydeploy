import React, { useState } from 'react';

/**
 * TimeSlotPicker
 *
 * Props:
 *  - slots        : { hour: number, minute: number, time: string, availableBays: number }[]
 *  - selectedTime : string  (e.g. "10:30 AM")
 *  - onSelect     : (time: string) => void
 *  - compact      : boolean  — true for narrow modal variants (admin/customer reschedule)
 */

const TIME_PERIODS = [
  { key: 'morning',   label: 'Morning',   emoji: '🌅', minHour: 6,  maxHour: 11 },
  { key: 'afternoon', label: 'Afternoon', emoji: '☀️', minHour: 12, maxHour: 17 },
  { key: 'evening',   label: 'Evening',   emoji: '🌙', minHour: 18, maxHour: 23 },
  { key: 'overnight', label: 'Overnight', emoji: '🦉', minHour: 0,  maxHour: 5  },
];

function getPeriodKey(hour) {
  if (hour >= 6  && hour <= 11) return 'morning';
  if (hour >= 12 && hour <= 17) return 'afternoon';
  if (hour >= 18 && hour <= 23) return 'evening';
  return 'overnight';
}

function getCapacityColor(bays) {
  if (bays >= 4) return '#10b981'; // green
  if (bays >= 2) return '#f59e0b'; // amber
  return '#ef4444';                // red
}

export default function TimeSlotPicker({ slots = [], selectedTime, onSelect, compact = false }) {
  // Start all groups expanded
  const [collapsed, setCollapsed] = useState({});

  const toggleGroup = (key) =>
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  // Group slots by time period
  const groups = TIME_PERIODS.map(period => ({
    ...period,
    slots: slots.filter(s => getPeriodKey(s.hour) === period.key),
  })).filter(g => g.slots.length > 0);

  if (groups.length === 0) return null;

  const pillCols = compact ? 'repeat(auto-fill, minmax(80px, 1fr))' : 'repeat(auto-fill, minmax(90px, 1fr))';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? '0.6rem' : '1rem' }}>
      <style>{`
        @media (max-width: 600px) {
          .tsp-pill-grid {
            grid-template-columns: repeat(2, 1fr) !important;
          }
        }
        .tsp-pill {
          transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
        }
        .tsp-pill:hover:not(.tsp-pill--selected) {
          border-color: var(--admin-brand) !important;
          transform: translateY(-1px);
        }
        .tsp-pill:active {
          transform: translateY(0);
        }
        .tsp-group-header {
          cursor: pointer;
          user-select: none;
        }
        .tsp-group-header:hover {
          opacity: 0.85;
        }
      `}</style>

      {groups.map(group => {
        const isCollapsed = collapsed[group.key];
        return (
          <div key={group.key}>
            {/* Group header */}
            <div
              className="tsp-group-header"
              onClick={() => toggleGroup(group.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: isCollapsed ? 0 : (compact ? '0.4rem' : '0.6rem'),
                padding: compact ? '0.3rem 0.1rem' : '0.4rem 0.1rem',
              }}
            >
              <span style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: compact ? '0.68rem' : '0.72rem',
                fontWeight: '900',
                color: 'var(--admin-text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.8px',
              }}>
                <span style={{ fontSize: compact ? '0.85rem' : '0.95rem' }}>{group.emoji}</span>
                {group.label}
                <span style={{
                  background: 'var(--admin-input-bg)',
                  border: '1px solid var(--admin-border)',
                  borderRadius: '999px',
                  padding: '0.05rem 0.45rem',
                  fontSize: '0.62rem',
                  fontWeight: '800',
                  color: 'var(--admin-text-secondary)',
                }}>
                  {group.slots.length}
                </span>
              </span>
              <span style={{
                fontSize: '0.65rem',
                color: 'var(--admin-text-secondary)',
                fontWeight: '700',
                opacity: 0.7,
              }}>
                {isCollapsed ? '▶ show' : '▼ hide'}
              </span>
            </div>

            {/* Pill grid */}
            {!isCollapsed && (
              <div
                className="tsp-pill-grid"
                style={{
                  display: 'grid',
                  gridTemplateColumns: pillCols,
                  gap: compact ? '0.4rem' : '0.5rem',
                }}
              >
                {group.slots.map(slot => {
                  const isSelected = selectedTime === slot.time;
                  const capColor = getCapacityColor(slot.availableBays);
                  return (
                    <button
                      key={slot.time}
                      type="button"
                      onClick={() => onSelect(slot.time)}
                      className={`tsp-pill${isSelected ? ' tsp-pill--selected' : ''}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.2rem',
                        padding: compact ? '0.45rem 0.3rem' : '0.55rem 0.35rem',
                        background: isSelected ? 'var(--admin-brand)' : 'var(--admin-input-bg)',
                        color: isSelected ? '#fff' : 'var(--admin-text-primary)',
                        border: `1px solid ${isSelected ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                        borderRadius: 'var(--admin-radius-sm)',
                        cursor: 'pointer',
                        fontWeight: '900',
                        fontSize: compact ? '0.72rem' : '0.78rem',
                        lineHeight: 1.2,
                        boxSizing: 'border-box',
                        width: '100%',
                        minWidth: 0,
                      }}
                    >
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                        {slot.time}
                      </span>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.15rem',
                        fontSize: compact ? '0.58rem' : '0.62rem',
                        fontWeight: '800',
                        color: isSelected ? 'rgba(255,255,255,0.85)' : capColor,
                        background: isSelected ? 'rgba(255,255,255,0.15)' : `${capColor}18`,
                        borderRadius: '999px',
                        padding: '0.05rem 0.35rem',
                        border: `1px solid ${isSelected ? 'rgba(255,255,255,0.25)' : `${capColor}40`}`,
                        whiteSpace: 'nowrap',
                      }}>
                        <span style={{
                          width: '5px',
                          height: '5px',
                          borderRadius: '50%',
                          background: isSelected ? 'rgba(255,255,255,0.85)' : capColor,
                          flexShrink: 0,
                        }} />
                        {slot.availableBays} bay{slot.availableBays === 1 ? '' : 's'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
