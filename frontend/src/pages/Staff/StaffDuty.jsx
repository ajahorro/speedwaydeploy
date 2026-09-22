import React, { useEffect, useState } from 'react';
import { Clock, LogIn, LogOut, MapPin, CheckCircle2, Timer } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useUI } from '../../context/UIContext';
import PageHeader from '../../components/PageHeader';

/**
 * Duty & Shift
 * ---------------------------------------------------------------------------
 * The single home for the clock-in / clock-out action, moved out of the sidebar
 * so the navigation stays focused on operational links. Keeps the shift timer
 * capping at 24h so a forgotten clock-out can never display a runaway duration.
 */
const MAX_SHIFT_SECONDS = 24 * 60 * 60;

const formatDuration = (totalSeconds) => {
  const secs = Math.min(Math.max(0, totalSeconds), MAX_SHIFT_SECONDS);
  const hrs = String(Math.floor(secs / 3600)).padStart(2, '0');
  const mins = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const out = String(secs % 60).padStart(2, '0');
  return `${hrs}:${mins}:${out}`;
};

const StaffDuty = () => {
  const { profile, toggleShift } = useAuth();
  const { openModal } = useUI();
  const [elapsed, setElapsed] = useState(0);
  // Guards against a double-submit (double-click / re-entrancy while the relay
  // call is in flight), which previously could fire two conflicting clock ops.
  const [isShiftBusy, setIsShiftBusy] = useState(false);

  const isClockedIn = Boolean(profile?.is_clocked_in);
  const startTs = profile?.clock_in_timestamp || profile?.updated_at;
  const shiftActionAvailable = Boolean(profile?.id) && typeof toggleShift === 'function' && !isShiftBusy;

  useEffect(() => {
    if (!isClockedIn || !startTs) {
      setElapsed(0);
      return undefined;
    }
    const start = new Date(startTs).getTime();
    const tick = () => {
      const diff = Math.floor((Date.now() - start) / 1000);
      // Cap at 24h: a shift that has silently run longer is almost certainly a
      // missed clock-out, so we surface the ceiling rather than 37:56:54.
      setElapsed(Math.min(Math.max(0, diff), MAX_SHIFT_SECONDS));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isClockedIn, startTs]);

  const handleClockIn = async () => {
    if (!shiftActionAvailable) return;
    setIsShiftBusy(true);
    try {
      await toggleShift(true);
    } finally {
      setIsShiftBusy(false);
    }
  };

  const handleClockOut = () => {
    // Defensive: never open a confirm modal — and never reach the API — without a
    // resolvable profile id and a toggleShift implementation.
    if (!shiftActionAvailable) return;

    openModal({
      title: 'End Shift?',
      message: 'Confirming clock-out will mark you as unavailable for new detailing assignments.',
      confirmText: 'Clock Out',
      type: 'danger',
      onConfirm: async () => {
        if (!profile?.id || typeof toggleShift !== 'function') return;
        setIsShiftBusy(true);
        try {
          await toggleShift(false);
        } finally {
          setIsShiftBusy(false);
        }
      }
    });
  };

  const cardStyle = {
    background: 'var(--admin-card)',
    border: '1px solid var(--admin-border)',
    borderRadius: 'var(--admin-radius-lg, 12px)',
    padding: 'clamp(1.5rem, 4vw, 2rem)',
    color: 'var(--admin-text-primary)',
    boxShadow: 'var(--admin-card-shadow)'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem' }}>
      <PageHeader
        badge="Duty & Shift"
        title="Duty & Shift"
        subtitle="Clock in to start receiving detailing assignments, and clock out when you are done."
      />

      <section style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '640px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: isClockedIn ? 'rgba(16, 185, 129, 0.12)' : 'rgba(169, 27, 24, 0.12)', border: `1px solid ${isClockedIn ? 'var(--status-success)' : 'var(--admin-brand)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isClockedIn ? 'var(--status-success)' : 'var(--admin-brand)' }}>
              <Clock size={24} />
            </div>
            <div>
              <div style={{ fontSize: '1rem', fontWeight: '900' }}>{isClockedIn ? 'On Duty' : 'Off Duty'}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: '600' }}>
                {isClockedIn ? 'You are available for new assignments.' : 'Clock in to receive new assignments.'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.85rem', background: 'var(--admin-input-bg)', border: '1px solid var(--admin-border)', borderRadius: '999px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: isClockedIn ? 'var(--status-success)' : 'var(--status-danger)' }} />
            <span style={{ fontSize: '0.65rem', fontWeight: '900', textTransform: 'uppercase', letterSpacing: '0.5px', color: isClockedIn ? 'var(--status-success)' : 'var(--status-danger)' }}>
              {isClockedIn ? 'ON DUTY' : 'OFF DUTY'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1rem 1.25rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '10px' }}>
          <Timer size={18} color="var(--admin-text-secondary)" />
          <div>
            <div style={{ fontSize: '0.6rem', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--admin-text-secondary)' }}>Current Shift Duration</div>
            <div style={{ fontSize: '1.4rem', fontWeight: '900', fontVariantNumeric: 'tabular-nums' }}>
              {isClockedIn ? formatDuration(elapsed) : '00:00:00'}
            </div>
          </div>
        </div>

        {isClockedIn ? (
          <button
            type="button"
            onClick={handleClockOut}
            disabled={!shiftActionAvailable}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem', padding: '1rem', background: 'var(--admin-bg)', border: '1px solid var(--status-danger)', color: 'var(--status-danger)', borderRadius: '8px', fontWeight: '900', fontSize: '0.85rem', cursor: shiftActionAvailable ? 'pointer' : 'not-allowed', opacity: shiftActionAvailable ? 1 : 0.55, textTransform: 'uppercase' }}
          >
            <LogOut size={18} /> Clock Out
          </button>
        ) : (
          <button
            type="button"
            onClick={handleClockIn}
            disabled={!shiftActionAvailable}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem', padding: '1rem', background: 'var(--admin-brand)', border: 'none', color: 'var(--admin-text-on-brand)', borderRadius: '8px', fontWeight: '900', fontSize: '0.85rem', cursor: shiftActionAvailable ? 'pointer' : 'not-allowed', opacity: shiftActionAvailable ? 1 : 0.55, textTransform: 'uppercase' }}
          >
            <LogIn size={18} /> Clock In
          </button>
        )}
      </section>

      <section style={{ ...cardStyle, maxWidth: '640px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <MapPin size={18} color="var(--admin-brand)" />
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: '900' }}>Station Preference</h2>
        </div>
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--admin-text-secondary)', lineHeight: 1.6, fontWeight: '600' }}>
          Your primary bay or station assignment is set by the shop. When you clock in you become available for the bays you are assigned to.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', fontWeight: '700', color: 'var(--admin-text-secondary)' }}>
          <CheckCircle2 size={16} color="var(--status-success)" /> Assigned stations are managed by your administrator.
        </div>
      </section>
    </div>
  );
};

export default StaffDuty;
