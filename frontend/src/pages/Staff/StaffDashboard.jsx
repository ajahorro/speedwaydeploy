import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { 
  ClipboardList, Clock, CheckCircle2, AlertCircle, 
  Car, User, ArrowRight, Play, Loader2, Image, Save, UploadCloud, TrendingUp, Bell
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useUI } from '../../context/UIContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import PhotoProofUploader from '../../components/Photos/PhotoProofUploader';
import IntakeWarningBadge from '../../components/Photos/IntakeWarningBadge';
import { BACKEND_URL } from '../../config/api';
const StaffDashboard = () => {
  const { profile } = useAuth();
  const { openModal } = useUI();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ pending: 0, active: 0, completed: 0 });
  const [localNotes, setLocalNotes] = useState({});
  const [broadcasts, setBroadcasts] = useState([]);
  const [shiftTimer, setShiftTimer] = useState('OFF DUTY');
  // Batch 5: per-unit photo counts, keyed by task.id -> { before, after }.
  // Drives the intake soft-warning and the completion hard-gate on the client.
  const [photoCounts, setPhotoCounts] = useState({});
  const setPhotoCount = (taskId, phase) => (count) =>
    setPhotoCounts((prev) => ({
      ...prev,
      [taskId]: { before: 0, after: 0, ...(prev[taskId] || {}), [phase]: count }
    }));

  useEffect(() => {
    if (!profile?.is_clocked_in) {
      setShiftTimer('OFF DUTY');
      return;
    }

    const rawClockIn = profile.clock_in_timestamp || profile.updated_at;
    const startTime = rawClockIn ? new Date(rawClockIn).getTime() : Date.now();
    // Cap at 24h so a missed clock-out can never show a runaway duration like
    // 37:56:54; the ceiling signals the shift needs attention.
    const MAX_SHIFT_SECONDS = 24 * 60 * 60;

    const updateTimer = () => {
      const now = Date.now();
      const diffSecs = Math.min(Math.max(0, Math.floor((now - startTime) / 1000)), MAX_SHIFT_SECONDS);
      const hrs = String(Math.floor(diffSecs / 3600)).padStart(2, '0');
      const mins = String(Math.floor((diffSecs % 3600) / 60)).padStart(2, '0');
      const secs = String(diffSecs % 60).padStart(2, '0');
      setShiftTimer(`${hrs}:${mins}:${secs}`);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [profile?.is_clocked_in, profile?.clock_in_timestamp, profile?.updated_at]);

  useEffect(() => {
    fetchAssignedTasks();

    // 📡 REQ-SYS-05: Real-time synchronization
    const channel = supabase
      .channel(`staff-tasks-${profile?.id}`)
      .on('postgres_changes', { 
        event: '*', 
        schema: 'public', 
        table: 'bookings',
        filter: `staff_id=eq.${profile?.id}`
      }, () => {
        fetchAssignedTasks();
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${profile?.id}`
      }, () => {
        fetchAssignedTasks();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [profile?.id]);

  const fetchAssignedTasks = async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('bookings')
        .select(`
          *,
          customer:profiles!bookings_customer_id_fkey(full_name, email, phone_number),
          vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services(*))
        `)
        .eq('staff_id', profile.id)
        .neq('status', 'cancelled')
        .order('start_datetime', { ascending: true });

      if (error) throw error;

      const allVehicleTasks = (data || []).flatMap(b => 
        b.vehicles.map(v => ({
          ...v,
          customer: b.customer,
          booking_id: b.id,
          booking_status: b.status,
          start_datetime: b.start_datetime
        }))
      ).filter(v => v.status?.toUpperCase() !== 'COMPLETED');

      setTasks(allVehicleTasks);
      const notesObj = {};
      allVehicleTasks.forEach(t => { notesObj[t.id] = t.service_notes || ''; });
      setLocalNotes(notesObj);
      
      const pending = allVehicleTasks.filter(t => t.status?.toUpperCase() === 'PENDING').length;
      const active = allVehicleTasks.filter(t => t.status?.toUpperCase() === 'IN_PROGRESS').length;
      const completed = allVehicleTasks.filter(t => t.status?.toUpperCase() === 'COMPLETED').length;
      setStats({ pending, active, completed });

      // Fetch System Broadcasts & Announcements
      const { data: notifData } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', profile.id)
        .order('created_at', { ascending: false })
        .limit(5);

      setBroadcasts(notifData || []);
    } catch (err) {
      console.error('Task Fetch Error:', err);
      toast.error('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async (task, newStatus, overrideReason = '') => {
    if (task.booking_status?.toLowerCase() === 'completed' || task.booking_status?.toLowerCase() === 'cancelled') {
      return toast.error('Booking is finalized.');
    }
    const toastId = toast.loading(`Updating unit status...`);
    try {
      const response = await fetch(`${BACKEND_URL}/api/bookings/update-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token || ''}` },
        body: JSON.stringify({
          bookingId: task.booking_id,
          unitId: task.id,
          newStatus: newStatus,
          notes: localNotes[task.id],
          actorName: profile?.full_name || 'Staff',
          actorRole: 'STAFF',
          // Batch 5: only meaningful for admins completing without an after photo.
          overrideReason: overrideReason || undefined
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'Lifecycle service unavailable. No status change was made.');
      toast.success(`Unit marked as ${newStatus.toUpperCase()}`, { id: toastId });
      return fetchAssignedTasks();
    } catch (err) {
      toast.error(err.message || 'Status update failed', { id: toastId });
    }
  };

  const canStartTask = (task) => {
    if (!profile?.is_clocked_in || !task.start_datetime) return false;
    const scheduled = new Date(task.start_datetime);
    const today = new Date();
    return scheduled.getFullYear() === today.getFullYear()
      && scheduled.getMonth() === today.getMonth()
      && scheduled.getDate() === today.getDate();
  };

  const requestUpdateStatus = (task, newStatus) => {
    openModal({
      title: newStatus === 'COMPLETED' ? 'Finalize Service?' : 'Start Service?',
      message: newStatus === 'COMPLETED'
        ? `Confirm completion for ${task.brand} ${task.model}. This will notify the customer.`
        : `Start service for ${task.brand} ${task.model}?`,
      confirmText: newStatus === 'COMPLETED' ? 'Finish Job' : 'Start Service',
      cancelText: 'Cancel',
      type: newStatus === 'COMPLETED' ? 'success' : 'info',
      onConfirm: () => handleUpdateStatus(task, newStatus)
    });
  };

  /**
   * Batch 5 — Start with a SOFT intake warning. If no 'before' photo exists we
   * still allow the start, but make the omission explicit and remind the tech.
   * The skip is inherently auditable via the absence of a before-phase row.
   */
  const requestStartTask = (task) => {
    const hasIntake = (photoCounts[task.id]?.before || 0) > 0;
    openModal({
      title: 'Start Service?',
      message: hasIntake
        ? `Start service for ${task.brand} ${task.model}?`
        : `No intake photo has been captured for ${task.brand} ${task.model}. You can still start, but documenting the pre-service condition is strongly recommended for dispute protection.`,
      confirmText: hasIntake ? 'Start Service' : 'Start Without Intake Photo',
      cancelText: 'Cancel',
      type: 'info',
      onConfirm: () => handleUpdateStatus(task, 'IN_PROGRESS')
    });
  };

  /**
   * Batch 5 — Admin override path for completing without a required after photo.
   * Collects a mandatory reason and forwards it to the backend, which records a
   * PHOTO_PROOF_OVERRIDE audit entry. Non-admins never reach this.
   */
  const requestCompleteWithOverride = (task) => {
    const reason = window.prompt(
      `No completion photo exists for ${task.brand} ${task.model}.\n\nAdmin override requires a reason (recorded in the audit log).`,
      ''
    );
    if (reason === null) return; // cancelled
    const trimmed = reason.trim();
    if (!trimmed) {
      toast.error('An override reason is required.');
      return;
    }
    openModal({
      title: 'Override & Finalize?',
      message: `Complete ${task.brand} ${task.model} WITHOUT a completion photo?\n\nReason: "${trimmed}"`,
      confirmText: 'Override & Finish',
      cancelText: 'Cancel',
      type: 'danger',
      onConfirm: () => handleUpdateStatus(task, 'COMPLETED', trimmed)
    });
  };

  const handleSaveNotes = async (taskId) => {
    const toastId = toast.loading('Saving notes...');
    try {
      const { error } = await supabase.from('booking_vehicles').update({ service_notes: localNotes[taskId] }).eq('id', taskId);
      if (error) throw error;
      toast.success('Notes saved!', { id: toastId });
      fetchAssignedTasks();
    } catch (err) {
      toast.error('Failed to save notes', { id: toastId });
    }
  };

  if (loading) return <LoadingState message="Loading your assignments..." />;

  const badgeStyle = (status) => {
    const s = status?.toUpperCase();
    return {
      fontSize: '0.6rem',
      fontWeight: '950',
      padding: '0.35rem 0.75rem',
      borderRadius: '4px',
      textTransform: 'uppercase',
      border: '1px solid currentColor',
      background: s === 'COMPLETED' ? 'rgba(16, 185, 129, 0.1)' : (s === 'IN_PROGRESS' ? 'rgba(245, 158, 11, 0.1)' : 'var(--admin-input-bg)'),
      color: s === 'COMPLETED' ? 'var(--status-success)' : (s === 'IN_PROGRESS' ? 'var(--status-warning)' : 'var(--admin-text-secondary)'),
      letterSpacing: '1px'
    };
  };

  const totalAssigned = stats.completed + stats.active + stats.pending;
  const completionRate = totalAssigned > 0 ? Math.round((stats.completed / totalAssigned) * 100) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '2rem' }}>
        <PageHeader
          badge="Today"
          title="Active Assignments"
          subtitle={`Ready for duty, ${profile?.full_name?.split(' ')[0]}. Vehicles assigned to you for detailing today.`}
        />

        <div style={{ background: 'var(--admin-card)', padding: '1.25rem', borderRadius: '8px', border: '1px solid var(--admin-border)', minWidth: '320px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <TrendingUp size={14} color="var(--status-success)" /> Shift Tracker
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: '1.1rem', fontWeight: '950', color: stats.active > 0 ? 'var(--status-warning)' : 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>
                {stats.active > 0 ? `${stats.active} In Progress` : 'No active job'}
              </div>
              <div style={{ fontSize: '0.55rem', color: 'var(--admin-text-secondary)', fontWeight: '950', textTransform: 'uppercase', marginTop: '0.25rem' }}>Active Job</div>
            </div>
            <div style={{ width: '1px', height: '30px', background: 'var(--admin-border)' }}></div>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: '1.1rem', fontWeight: '950', color: profile?.is_clocked_in ? 'var(--status-success)' : 'var(--admin-brand)', textTransform: 'uppercase' }}>
                {shiftTimer}
              </div>
              <div style={{ fontSize: '0.55rem', color: 'var(--admin-text-secondary)', fontWeight: '950', textTransform: 'uppercase', marginTop: '0.25rem' }}>Current Shift</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '2rem', alignItems: 'start' }}>
        <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <ClipboardList size={20} color="var(--admin-brand)" />
            <h3 style={{ margin: 0, fontSize: '0.85rem', fontWeight: '950', color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Active Assignments
            </h3>
          </div>

          {tasks.length > 0 ? (
            tasks.map((task) => (
              <div key={task.id} style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '8px', overflow: 'hidden', transition: 'all 0.2s', opacity: task.status === 'COMPLETED' ? 0.7 : 1 }}>
                <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--admin-bg)' }}>
                  <div
                    onClick={() => navigate(`/staff/job/${task.id}`)}
                    style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', cursor: 'pointer' }}
                  >
                    <div style={{ width: '56px', height: '56px', borderRadius: '8px', background: 'var(--admin-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-brand)', border: '1px solid var(--admin-border)' }}>
                      <Car size={28} />
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                        <span style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-brand)', background: 'rgba(var(--admin-brand-rgb, 169, 27, 24), 0.1)', padding: '0.2rem 0.5rem', borderRadius: '2px', letterSpacing: '1px' }}>JOB #{task.id.slice(0, 8).toUpperCase()}</span>
                        <span style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>• Plate: {task.plate_number || 'N/A'}</span>
                      </div>
                      <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{task.brand} {task.model}</h3>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={badgeStyle(task.status)}>{task.status?.toUpperCase()}</div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--admin-text-secondary)', fontWeight: '900', marginTop: '0.5rem', textTransform: 'uppercase' }}>
                      Sch: {new Date(task.start_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>

                <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                  <div style={{ background: 'var(--admin-bg)', borderRadius: '6px', padding: '1.25rem', border: '1px solid var(--admin-border)' }}>
                    <div style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.75rem' }}>Service Breakdown</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
                      {task.services?.map((s, idx) => (
                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--admin-card)', padding: '0.4rem 0.8rem', borderRadius: '4px', border: '1px solid var(--admin-border)' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--admin-brand)' }}></div>
                          <span style={{ fontSize: '0.7rem', color: 'var(--admin-text-primary)', fontWeight: '800', textTransform: 'uppercase' }}>{s.service_name}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {task.status?.toUpperCase() !== 'PENDING' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                      <div style={{ position: 'relative' }}>
                        <div style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.5rem' }}>Detailing Observations</div>
                        <textarea
                          placeholder="Document service steps or vehicle conditions..."
                          value={localNotes[task.id] || ''}
                          onChange={(e) => setLocalNotes({ ...localNotes, [task.id]: e.target.value })}
                          disabled={!profile?.is_clocked_in || task.status?.toUpperCase() === 'COMPLETED'}
                          style={{ width: '100%', minHeight: '100px', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '1rem', color: 'var(--admin-text-primary)', fontSize: '0.8rem', fontWeight: '600', outline: 'none', resize: 'none' }}
                        />
                        <button onClick={() => handleSaveNotes(task.id)} disabled={!profile?.is_clocked_in || task.status?.toUpperCase() === 'COMPLETED'} style={{ position: 'absolute', bottom: '0.5rem', right: '0.5rem', background: 'var(--admin-brand)', color: 'var(--admin-text-primary)', border: 'none', borderRadius: '4px', padding: '0.5rem', cursor: 'pointer' }}>
                          <Save size={16} />
                        </button>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.5rem' }}>Service Evidence</div>
                        <p style={{ margin: '0 0 0.5rem', fontSize: '0.62rem', color: 'var(--admin-text-secondary)', fontWeight: '700', lineHeight: 1.5 }}>
                          Intake photos are recommended (a warning is logged if skipped). At least one completion photo is required to finish.
                        </p>
                        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0.75rem' }}>
                          <PhotoProofUploader
                            bookingId={task.booking_id}
                            bookingVehicleId={task.id}
                            phase="before"
                            compact
                            helperText="Capture the vehicle condition before work begins."
                            onCountChange={setPhotoCount(task.id, 'before')}
                          />
                          <PhotoProofUploader
                            bookingId={task.booking_id}
                            bookingVehicleId={task.id}
                            phase="after"
                            compact
                            helperText="Required: at least one QA photo before marking finished."
                            onCountChange={setPhotoCount(task.id, 'after')}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    {task.status?.toUpperCase() === 'PENDING' && (
                      <>
                        {/* Soft intake warning: surfaced next to Start, never blocking. */}
                        {(photoCounts[task.id]?.before || 0) < 1 && (
                          <IntakeWarningBadge tone="warning" compact>No intake photo — recommended</IntakeWarningBadge>
                        )}
                        <button onClick={() => requestStartTask(task)} disabled={!canStartTask(task)} style={{ flex: 1, minWidth: '200px', padding: '1rem', background: canStartTask(task) ? 'var(--admin-brand)' : 'var(--admin-border)', color: canStartTask(task) ? 'var(--admin-text-on-brand)' : 'var(--admin-text-secondary)', border: 'none', borderRadius: '4px', fontWeight: '950', fontSize: '0.8rem', cursor: canStartTask(task) ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
                          <Play size={18} /> START SERVICE
                        </button>
                      </>
                    )}
                    {task.status?.toUpperCase() === 'IN_PROGRESS' && (() => {
                      const afterCount = photoCounts[task.id]?.after || 0;
                      const missingAfter = afterCount < 1;
                      const canComplete = Boolean(profile?.is_clocked_in) && !missingAfter;
                      // Admins may override the photo gate with a logged reason.
                      const isAdmin = String(profile?.role || '').toUpperCase() === 'ADMIN';
                      return (
                        <>
                          {missingAfter && (
                            <IntakeWarningBadge tone="danger" compact>Completion photo required</IntakeWarningBadge>
                          )}
                          <button
                            onClick={() => (missingAfter && isAdmin ? requestCompleteWithOverride(task) : requestUpdateStatus(task, 'COMPLETED'))}
                            disabled={!profile?.is_clocked_in || (missingAfter && !isAdmin)}
                            title={
                              !profile?.is_clocked_in
                                ? 'Clock in to update the job.'
                                : missingAfter
                                  ? (isAdmin
                                      ? 'No completion photo. As an admin you may override with a logged reason.'
                                      : 'Add at least 1 completion (after) photo to finish.')
                                  : 'Mark this job as finished.'
                            }
                            style={{ flex: 1, minWidth: '200px', padding: '1rem', background: canComplete ? 'var(--status-success)' : (missingAfter && isAdmin ? 'var(--status-warning)' : 'var(--admin-border)'), color: canComplete || (missingAfter && isAdmin) ? 'white' : 'var(--admin-text-secondary)', border: 'none', borderRadius: '4px', fontWeight: '950', fontSize: '0.8rem', cursor: !profile?.is_clocked_in || (missingAfter && !isAdmin) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', textTransform: 'uppercase', letterSpacing: '1px' }}
                          >
                            <CheckCircle2 size={18} /> {missingAfter && isAdmin ? 'OVERRIDE & FINISH' : 'MARK AS FINISHED'}
                          </button>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div style={{ background: 'var(--admin-card)', border: '1px dashed var(--admin-border)', borderRadius: '8px', textAlign: 'center', padding: '2rem 1.5rem', minHeight: '180px', maxHeight: '220px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <ClipboardList size={36} style={{ marginBottom: '1rem', opacity: 0.25, color: 'var(--admin-text-secondary)' }} />
              <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: '800', color: 'var(--admin-text-primary)' }}>No active assignments</h3>
              <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.75rem', fontWeight: '600', marginTop: '0.4rem' }}>Vehicles assigned to you will appear here.</p>
            </div>
          )}
        </div>

        <div style={{ width: isMobile ? '100%' : '320px', display: 'flex', flexDirection: 'column', gap: '2rem', position: 'sticky', top: '100px' }}>
          {/* System Broadcasts & Announcements */}
          <div style={{ background: 'var(--admin-card)', borderRadius: '8px', border: '1px solid var(--admin-border)', overflow: 'hidden' }}>
            <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Bell size={18} color="var(--admin-brand)" />
              <h3 style={{ margin: 0, fontSize: '0.75rem', fontWeight: '950', color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Shop Bulletins
              </h3>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {broadcasts.length > 0 ? (
                broadcasts.map(b => (
                  <div key={b.id} style={{ padding: '1.25rem', borderBottom: '1px solid var(--admin-border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', alignItems: 'center' }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: '900', color: 'var(--admin-text-primary)' }}>{b.title || 'Announcement'}</div>
                      <div style={{ fontSize: '0.55rem', fontWeight: '900', color: 'var(--admin-text-secondary)' }}>
                        {b.created_at ? new Date(b.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}
                      </div>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: '600', lineHeight: 1.4 }}>{b.message}</div>
                  </div>
                ))
              ) : (
                <div style={{ padding: '2rem 1.25rem', textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.75rem', fontWeight: '600' }}>
                  No active shop announcements
                </div>
              )}
            </div>
          </div>

          {!profile?.is_clocked_in && (
            <div style={{ padding: '1.25rem', background: 'rgba(var(--admin-brand-rgb, 169, 27, 24), 0.05)', border: '1px solid rgba(var(--admin-brand-rgb, 169, 27, 24), 0.15)', borderRadius: '8px', textAlign: 'center' }}>
              <Clock size={24} color="var(--admin-brand)" style={{ margin: '0 auto 0.75rem' }} />
              <div style={{ fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-brand)', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Not Clocked In</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--admin-text-secondary)', fontWeight: '700' }}>Open Duty &amp; Shift to clock in and enable service controls.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StaffDashboard;
