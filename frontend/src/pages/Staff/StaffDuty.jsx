import React, { useEffect, useState } from 'react';
import { AlertTriangle, Clock, LogIn, LogOut, MapPin, CheckCircle2, Timer } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';
import { useUI } from '../../context/UIContext';
import PageHeader from '../../components/PageHeader';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

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
  const { confirmThen } = useConfirmAction();
  const { profile, toggleShift } = useAuth();
  const { openModal } = useUI();
  const [elapsed, setElapsed] = useState(0);
  const [shiftOverdue, setShiftOverdue] = useState(false);
  // Guards against a double-submit (double-click / re-entrancy while the relay
  // call is in flight), which previously could fire two conflicting clock ops.
  const [isShiftBusy, setIsShiftBusy] = useState(false);

  const [blockers, setBlockers] = useState([]);

  const isClockedIn = Boolean(profile?.is_clocked_in);
  const startTs = profile?.clock_in_timestamp || profile?.updated_at;
  const shiftActionAvailable = Boolean(profile?.id) && typeof toggleShift === 'function' && !isShiftBusy;

  useEffect(() => {
    if (!isClockedIn || !startTs) {
      setElapsed(0);
      setShiftOverdue(false);
      return undefined;
    }
    const start = new Date(startTs).getTime();
    const tick = () => {
      const diff = Math.floor((Date.now() - start) / 1000);
      // Cap at 24h: a shift that has silently run longer is almost certainly a
      // missed clock-out, so we surface the ceiling rather than 37:56:54.
      setShiftOverdue(diff > MAX_SHIFT_SECONDS);
      setElapsed(Math.min(Math.max(0, diff), MAX_SHIFT_SECONDS));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isClockedIn, startTs]);

  // Jobs that stop a clock-out (one under way, or one starting within 5 minutes); re-checked every 30 seconds
  useEffect(() => {
    if (!isClockedIn) { setBlockers([]); return undefined; }
    let alive = true;
    const check = async () => {
      const { data } = await supabase.rpc('my_clock_out_blockers');
      if (alive) setBlockers(data || []);
    };
    check();
    const timer = setInterval(check, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [isClockedIn]);

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
    if (!shiftActionAvailable || blockers.length > 0) return;

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem' }}>
      <PageHeader
        badge="Duty & Shift"
        title="Duty & Shift"
        subtitle="Clock in to start receiving detailing assignments, and clock out when you are done."
      />

      <Card className="ui-root max-w-2xl gap-5 rounded-md p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`grid size-12 place-items-center rounded-md border ${isClockedIn ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-primary/50 bg-primary/10 text-primary'}`}>
              <Clock className="size-6" aria-hidden="true" />
            </div>
            <div>
              <p className="font-semibold">{isClockedIn ? 'On Duty' : 'Off Duty'}</p>
              <p className="text-xs text-muted-foreground">
                {isClockedIn ? 'You are available for new assignments.' : 'Clock in to receive new assignments.'}
              </p>
            </div>
          </div>
          <Badge variant="outline" className={`gap-2 uppercase ${isClockedIn ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-destructive/40 text-destructive'}`}>
            <span className={`size-2 rounded-full ${isClockedIn ? 'bg-emerald-500' : 'bg-destructive'}`} aria-hidden="true" />
            {isClockedIn ? 'ON DUTY' : 'OFF DUTY'}
          </Badge>
        </div>

        <div className="flex items-center gap-3 rounded-md border px-4 py-3">
          <Timer className="size-[18px] text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Current Shift Duration</p>
            <p className="text-2xl font-bold tabular-nums">
              {isClockedIn ? `${formatDuration(elapsed)}${shiftOverdue ? '+' : ''}` : '00:00:00'}
            </p>
          </div>
        </div>

        {shiftOverdue && (
          <Alert variant="warning">
            <AlertTriangle aria-hidden="true" />
            <AlertDescription>This shift has exceeded 24 hours. The displayed duration is capped; check your shift status with an administrator.</AlertDescription>
          </Alert>
        )}

        {isClockedIn && blockers.length > 0 && (
          <Alert variant="warning">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>You cannot clock out yet.</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {blockers.map((b) => (
                  <li key={b.vehicle_id}>{b.vehicle_label || 'Assigned vehicle'} — {b.reason === 'STARTS_SOON' ? 'starts within 5 minutes' : 'already under way'}</li>
                ))}
              </ul>
              <p>If you really need to clock out, ask an admin to assign another staff member to it.</p>
            </AlertDescription>
          </Alert>
        )}

        {isClockedIn ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={handleClockOut}
            disabled={!shiftActionAvailable || blockers.length > 0}
            className="border-destructive text-destructive hover:text-destructive"
          >
            <LogOut /> Clock Out
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            onClick={() => confirmThen({ title: 'Start your shift?', message: 'You will be marked on duty and can receive assignments.', confirmText: 'Start shift' }, handleClockIn)}
            disabled={!shiftActionAvailable}
          >
            <LogIn /> Clock In
          </Button>
        )}
      </Card>

      <Card className="ui-root max-w-2xl gap-3 rounded-md p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <MapPin className="size-[18px] text-primary" aria-hidden="true" />
          <h2 className="text-base font-semibold">Station Preference</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Your primary bay or station assignment is set by the shop. When you clock in you become available for the bays you are assigned to.
        </p>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-emerald-500" aria-hidden="true" /> Assigned stations are managed by your administrator.
        </p>
      </Card>
    </div>
  );
};

export default StaffDuty;
