import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Clock, ExternalLink } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';

const DAYS_PER_PAGE = 3;

const dayLabel = (day) => new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
const timeLabel = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—');
const dateTimeLabel = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded');
const statusWords = (status) => String(status || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const hoursBetween = (from, to) => {
  const minutes = Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};

const Row = ({ label, children }) => (
  <div className="grid gap-0.5">
    <dt className="text-xs font-semibold uppercase text-muted-foreground">{label}</dt>
    <dd className="text-sm [overflow-wrap:anywhere]">{children}</dd>
  </div>
);

function VehicleRow({ vehicle, isAdmin, onViewBooking }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-md border">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><strong>{[vehicle.brand, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</strong> · {vehicle.plate_number || 'No plate'}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{statusWords(vehicle.status)}</span>
      </button>
      {open && (
        <div className="grid gap-3 border-t px-3 py-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            {isAdmin && <Row label="Customer">{vehicle.customer_name || '—'}</Row>}
            <Row label="Vehicle type">{vehicle.vehicle_type || '—'}</Row>
            <Row label="Scheduled">{dateTimeLabel(vehicle.start_datetime)}</Row>
            <Row label="Status">{statusWords(vehicle.status)}</Row>
            <Row label="Started">{dateTimeLabel(vehicle.started_at)}</Row>
            <Row label="Finished">{dateTimeLabel(vehicle.completed_at)}</Row>
          </dl>
          <dl className="grid gap-3">
            <Row label="Services">{(vehicle.services || []).length ? vehicle.services.join(', ') : '—'}</Row>
            {vehicle.service_notes && <Row label="Notes">{vehicle.service_notes}</Row>}
          </dl>
          {isAdmin && (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => onViewBooking(vehicle.booking_id)}>
                <ExternalLink /> View booking
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function DayRow({ entry, isAdmin, onViewBooking }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  const sessions = entry.sessions || [];
  const vehicles = entry.vehicles || [];
  return (
    <li className="rounded-md border">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-3 text-left">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-sm font-semibold">{dayLabel(entry.day)}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {sessions.length} shift{sessions.length === 1 ? '' : 's'} · {vehicles.length} vehicle{vehicles.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div className="grid gap-4 border-t px-3 py-3">
          <div className="grid gap-1.5">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"><Clock className="size-3.5" aria-hidden="true" /> Clock in and out</h4>
            {sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No clock-in on this day.</p>
            ) : (
              <ul className="m-0 grid list-none gap-1 p-0 text-sm">
                {sessions.map((s) => (
                  <li key={s.id} className="flex flex-wrap justify-between gap-x-4">
                    <span>{timeLabel(s.clock_in_at)} → {s.clock_out_at ? timeLabel(s.clock_out_at) : <em>still on shift</em>}</span>
                    <span className="text-muted-foreground">{s.clock_out_at ? hoursBetween(s.clock_in_at, s.clock_out_at) : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid gap-1.5">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground">Vehicles</h4>
            {vehicles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No vehicles scheduled on this day.</p>
            ) : (
              <ul className="m-0 grid list-none gap-2 p-0">
                {vehicles.map((v) => <VehicleRow key={v.id} vehicle={v} isAdmin={isAdmin} onViewBooking={onViewBooking} />)}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * A technician's history by day: the clock-ins and the vehicles of each day, three days at a time so the
 * database never loads everything at once. Day rows open to the clock in/out times and collapsed vehicle
 * rows; a vehicle row opens to the full details. Administrators also get a "View booking" button.
 */
export default function WorkHistoryByDay({ staffId, isAdmin = false, onNavigate }) {
  const navigate = useNavigate();
  const [days, setDays] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (before) => {
    setLoading(true);
    setError('');
    try {
      const { data, error: rpcError } = await supabase.rpc('staff_work_history', { p_staff: staffId, p_before: before || null, p_days: DAYS_PER_PAGE });
      if (rpcError) throw rpcError;
      setDays((prev) => (before ? [...prev, ...(data?.days || [])] : (data?.days || [])));
      setHasMore(Boolean(data?.has_more));
    } catch (err) {
      setError(err.message || 'Could not load the history.');
    } finally {
      setLoading(false);
    }
  }, [staffId]);

  useEffect(() => {
    if (staffId) load(null);
  }, [staffId, load]);

  const viewBooking = (bookingId) => {
    if (onNavigate) onNavigate();
    navigate(`/admin/bookings/${bookingId}`);
  };

  if (error) return <p role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">{error}</p>;
  if (!loading && days.length === 0) return <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">No attendance or vehicles recorded yet.</p>;

  return (
    <div className="grid gap-3">
      <ul className="m-0 grid list-none gap-2 p-0">
        {days.map((entry) => <DayRow key={entry.day} entry={entry} isAdmin={isAdmin} onViewBooking={viewBooking} />)}
      </ul>
      {loading && <p className="text-center text-sm text-muted-foreground">Loading…</p>}
      {!loading && hasMore && (
        <Button type="button" variant="outline" onClick={() => load(days[days.length - 1]?.day)}>See more</Button>
      )}
    </div>
  );
}
