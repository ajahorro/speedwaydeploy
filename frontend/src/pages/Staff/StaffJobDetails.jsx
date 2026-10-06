import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { subscribeTables } from '../../lib/realtimeHub';
import {
  Car, Clock, CheckCircle2, ChevronLeft, Play, Save, ShieldCheck, User
} from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import toast from '@/lib/toast';
import { useAuth } from '../../hooks/useAuth';
import { useUI } from '../../context/UIContext';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import PhotoProofUploader from '../../components/Photos/PhotoProofUploader';
import StartChecklist from '../../components/Photos/StartChecklist';
import IntakeWarningBadge from '../../components/Photos/IntakeWarningBadge';
import CustomerContact from '../../components/Staff/CustomerContact';
import { startReadiness } from '../../utils/staffStart';
import { fetchStaffBookings } from '../../utils/notificationRouting';
import { BACKEND_URL } from '../../config/api';

/**
 * The one page for a single assigned vehicle. Everything a technician does on a job happens here:
 * check the details, add the before photo, start, add notes, add the after photo, finish.
 * Notifications, the dashboard and the work history all open this page.
 */
const StaffJobDetails = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { openModal } = useUI();
  const { confirmThen } = useConfirmAction();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [unit, setUnit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [photoCounts, setPhotoCounts] = useState({ before: 0, after: 0 });

  const fetchJobDetails = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const bookings = await fetchStaffBookings(supabase, { vehicleId: id });
      const booking = bookings[0];
      const vehicle = booking?.vehicles?.find((item) => item.id === id);
      if (!booking || !vehicle) {
        toast.error('This vehicle is not available in your assigned work.');
        navigate('/staff', { replace: true });
        return;
      }
      setUnit({
        ...vehicle,
        booking: {
          id: booking.id,
          status: booking.status,
          start_datetime: booking.start_datetime,
          end_datetime: booking.end_datetime,
          customer_name: booking.customer_name,
          contact_number: booking.contact_number
        }
      });
      setNotes((current) => (silent && current ? current : (vehicle.service_notes || '')));
    } catch (err) {
      console.error('Job Details Error:', err);
      toast.error('Failed to load job details');
      navigate('/staff', { replace: true });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => { fetchJobDetails(); }, [fetchJobDetails]);

  useEffect(() => {
    if (!profile?.id) return undefined;
    return subscribeTables([
      { table: 'booking_vehicles', filter: `staff_id=eq.${profile.id}` }
    ], () => fetchJobDetails({ silent: true }));
  }, [profile?.id, fetchJobDetails]);

  if (loading) return <LoadingState message="Loading job..." />;
  if (!unit) return null;

  const status = String(unit.status || '').toUpperCase();
  const isStartable = ['PENDING', 'SCHEDULED', 'CONFIRMED'].includes(status);
  const isRunning = status === 'IN_PROGRESS';
  const isDone = status === 'COMPLETED';
  const bookingClosed = ['completed', 'cancelled'].includes(String(unit.booking?.status || '').toLowerCase());
  const clockedIn = Boolean(profile?.is_clocked_in);
  const canStart = startReadiness({ clockedIn, beforePhotos: photoCounts.before, startDatetime: unit.booking?.start_datetime }).ok;
  const missingAfter = photoCounts.after < 1;
  const canFinish = clockedIn && !missingAfter;

  const updateStatus = async (newStatus) => {
    if (bookingClosed) return toast.error('Booking is finalized.');
    setBusy(true);
    const toastId = toast.loading('Updating status...');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`${BACKEND_URL}/api/bookings/update-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({
          bookingId: unit.booking.id,
          unitId: unit.id,
          newStatus,
          notes,
          actorName: profile?.full_name || 'Staff',
          actorRole: 'STAFF'
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'Lifecycle service unavailable. No status change was made.');
      toast.success(newStatus === 'COMPLETED' ? 'Job finished' : 'Service started', { id: toastId });
      await fetchJobDetails({ silent: true });
    } catch (err) {
      toast.error(err.message || 'Status update failed', { id: toastId });
    } finally {
      setBusy(false);
    }
  };

  const requestStatus = (newStatus) => openModal({
    title: newStatus === 'COMPLETED' ? 'Finalize Service?' : 'Start Service?',
    message: newStatus === 'COMPLETED'
      ? `Confirm completion for ${unit.brand} ${unit.model}. This will notify the customer.`
      : `Start service for ${unit.brand} ${unit.model}?`,
    confirmText: newStatus === 'COMPLETED' ? 'Finish Job' : 'Start Service',
    cancelText: 'Cancel',
    type: newStatus === 'COMPLETED' ? 'success' : 'info',
    onConfirm: () => updateStatus(newStatus)
  });

  const saveNotes = async () => {
    const toastId = toast.loading('Saving notes...');
    try {
      const { error } = await supabase.rpc('update_booking_vehicle_service_notes', { p_vehicle_id: unit.id, p_notes: notes });
      if (error) throw error;
      toast.success('Notes saved', { id: toastId });
    } catch {
      toast.error('Failed to save notes', { id: toastId });
    }
  };

  const setCount = (phase) => (count) => setPhotoCounts((prev) => (prev[phase] === count ? prev : { ...prev, [phase]: count }));

  const card = {
    background: 'var(--admin-card)', boxShadow: 'var(--admin-card-shadow)', border: '1px solid var(--admin-border)',
    borderRadius: 'var(--admin-radius)', padding: isMobile ? '1rem' : '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem'
  };
  const label = { fontSize: '0.72rem', fontWeight: 950, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' };
  const heading = { display: 'flex', alignItems: 'center', gap: '0.6rem', margin: 0, fontSize: '0.85rem', fontWeight: 950, textTransform: 'uppercase' };
  const value = { fontSize: '0.9rem', fontWeight: 700, color: 'var(--admin-text-primary)', overflowWrap: 'anywhere' };
  const statusColor = isDone ? 'var(--status-success)' : (isRunning ? 'var(--status-warning)' : 'var(--admin-text-secondary)');
  const time = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem' }}>
      <button
        type="button"
        onClick={() => navigate('/staff')}
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'none', border: 'none', color: 'var(--admin-text-secondary)', fontSize: '0.75rem', fontWeight: 950, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '1px', alignSelf: 'flex-start', padding: 0 }}
      >
        <ChevronLeft size={16} /> My assignments
      </button>

      <PageHeader
        badge={`${unit.plate_number || 'NO PLATE'}`}
        title={`${unit.brand || ''} ${unit.model || ''}`.trim() || 'Assigned vehicle'}
        subtitle={`Scheduled ${time(unit.booking?.start_datetime)}`}
      />

      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '1.5rem', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <section style={card}>
            <h3 style={heading}><Car size={18} color="var(--admin-brand)" /> Vehicle and customer</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem' }}>
              <div><div style={label}>Vehicle</div><div style={value}>{unit.brand} {unit.model}</div></div>
              <div><div style={label}>Plate</div><div style={{ ...value, color: 'var(--admin-brand)' }}>{unit.plate_number || 'N/A'}</div></div>
              <div><div style={label}>Type</div><div style={value}>{unit.vehicle_type || 'Standard'}</div></div>
              <div><div style={label}>Status</div><div style={{ ...value, color: statusColor }}>{status.replace(/_/g, ' ')}</div></div>
            </div>
            {(unit.booking?.customer_name || unit.booking?.contact_number) && (
              <div>
                <div style={{ ...label, display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}><User size={13} /> Customer</div>
                <CustomerContact name={unit.booking?.customer_name} phone={unit.booking?.contact_number} />
              </div>
            )}
          </section>

          <section style={card}>
            <h3 style={heading}><ShieldCheck size={18} color="var(--status-success)" /> Services</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {(unit.services || []).map((s, i) => (
                <span key={i} style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', padding: '0.4rem 0.7rem' }}>
                  {s.service_name}
                </span>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem' }}>
              <div><div style={label}>Started</div><div style={value}>{time(unit.started_at)}</div></div>
              <div><div style={label}>Finished</div><div style={value}>{time(unit.completed_at)}</div></div>
            </div>
          </section>
        </div>

        <div style={{ flex: 1, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <section style={card}>
            <h3 style={heading}><Clock size={18} color="var(--status-warning)" /> Service evidence</h3>
            <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 700, lineHeight: 1.5, color: 'var(--admin-text-secondary)' }}>
              {isDone ? 'This job is finished. The photos below are the saved evidence.'
                : isRunning ? 'Service started. Add at least one completion photo to finish the job.'
                  : 'Add at least one before photo, then start the service.'}
            </p>

            <PhotoProofUploader
              bookingId={unit.booking.id}
              bookingVehicleId={unit.id}
              phase="before"
              disabled={isRunning || isDone}
              compact
              helperText="Capture the vehicle condition before work begins."
              onCountChange={setCount('before')}
            />
            {(isRunning || isDone) && (
              <PhotoProofUploader
                bookingId={unit.booking.id}
                bookingVehicleId={unit.id}
                phase="after"
                disabled={isDone}
                compact
                helperText="Required: at least one photo of the finished work."
                onCountChange={setCount('after')}
              />
            )}

            {!isDone && (
              <div>
                <div style={{ ...label, marginBottom: '0.4rem' }}>Notes</div>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Service steps or vehicle condition..."
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-no-auto-capitalize=""
                  disabled={!clockedIn}
                  style={{ width: '100%', boxSizing: 'border-box', minHeight: '90px', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', padding: '0.75rem', color: 'var(--admin-text-primary)', fontSize: '0.85rem', fontFamily: 'inherit', resize: 'vertical' }}
                />
                <button
                  type="button"
                  onClick={() => confirmThen({ title: 'Save notes?', message: 'The notes are saved to this job for the admin and customer record.', confirmText: 'Save notes' }, saveNotes)}
                  disabled={!clockedIn}
                  style={{ marginTop: '0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.55rem 1rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', color: 'var(--admin-text-primary)', fontWeight: 900, fontSize: '0.72rem', textTransform: 'uppercase', cursor: clockedIn ? 'pointer' : 'not-allowed', opacity: clockedIn ? 1 : 0.5 }}
                >
                  <Save size={14} /> Save notes
                </button>
              </div>
            )}
            {isDone && unit.service_notes && (
              <div>
                <div style={{ ...label, marginBottom: '0.4rem' }}>Notes</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>{unit.service_notes}</div>
              </div>
            )}
          </section>

          {!isDone && !bookingClosed && (
            <section style={card}>
              <h3 style={heading}>{isStartable ? 'Start this job' : 'Finish this job'}</h3>
              {isStartable && (
                <>
                  <StartChecklist taskId={unit.id} clockedIn={clockedIn} beforePhotos={photoCounts.before} startDatetime={unit.booking?.start_datetime} />
                  <button
                    type="button"
                    onClick={() => requestStatus('IN_PROGRESS')}
                    disabled={!canStart || busy}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', width: '100%', padding: '0.9rem', background: canStart ? 'var(--admin-brand)' : 'var(--admin-border)', color: canStart ? 'var(--admin-text-on-brand)' : 'var(--admin-text-secondary)', border: 'none', borderRadius: 'var(--admin-radius)', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '1px', cursor: canStart && !busy ? 'pointer' : 'not-allowed' }}
                  >
                    <Play size={16} /> Start service
                  </button>
                </>
              )}
              {isRunning && (
                <>
                  {missingAfter && <IntakeWarningBadge tone="danger" compact>Completion photo required</IntakeWarningBadge>}
                  {!clockedIn && <IntakeWarningBadge tone="warning" compact>Clock in to finish</IntakeWarningBadge>}
                  <button
                    type="button"
                    onClick={() => requestStatus('COMPLETED')}
                    disabled={!canFinish || busy}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', width: '100%', padding: '0.9rem', background: canFinish ? 'var(--status-success)' : 'var(--admin-border)', color: canFinish ? 'white' : 'var(--admin-text-secondary)', border: 'none', borderRadius: 'var(--admin-radius)', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '1px', cursor: canFinish && !busy ? 'pointer' : 'not-allowed' }}
                  >
                    <CheckCircle2 size={16} /> Mark as finished
                  </button>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default StaffJobDetails;
