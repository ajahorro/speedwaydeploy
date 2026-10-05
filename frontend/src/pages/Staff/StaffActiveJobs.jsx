import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { useUI } from '../../context/UIContext';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Car, Clock, Play, CheckCircle2, Save, UploadCloud, Image as ImageIcon } from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import PhotoProofUploader from '../../components/Photos/PhotoProofUploader';
import toast from 'react-hot-toast';
import { BACKEND_URL } from '../../config/api';
import { SHOW_START_SERVICE_ACTIONS } from '../../config/workflowFeatures';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import StartChecklist from '../../components/Photos/StartChecklist';
import { startReadiness } from '../../utils/staffStart';
import CustomerContact from '../../components/Staff/CustomerContact';

const StaffActiveJobs = () => {
  const { confirmThen } = useConfirmAction();
  const { profile } = useAuth();
  const { openModal } = useUI();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [localNotes, setLocalNotes] = useState({});
  const [photoCounts, setPhotoCounts] = useState({});

  useEffect(() => {
    fetchActiveTasks();
  }, [profile?.id]);

  const fetchActiveTasks = async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`${BACKEND_URL}/api/staff/tasks`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${session?.access_token || ''}` }
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        const diagnostic = result.diagnostic
          ? ` [${result.diagnostic.stage}, ${result.diagnostic.code}${result.diagnostic.missingColumn ? `: ${result.diagnostic.missingColumn}` : ''}]`
          : '';
        throw new Error(`${result.error || 'Could not load assigned work.'}${diagnostic}`);
      }
      const data = result.bookings || [];

      const activeUnits = (data || []).flatMap(b =>
        (b.vehicles || []).map(v => ({
          ...v,
          booking_id: b.id,
          booking_status: b.status,
          customer_name: b.customer_name,
          contact_number: b.contact_number,
          start_datetime: b.start_datetime
        }))
      ).filter(v => v.status?.toUpperCase() !== 'COMPLETED');
      activeUnits.sort((a, b) => {
        const priority = (task) => task.status?.toUpperCase() === 'IN_PROGRESS' ? 0 : task.status?.toUpperCase() === 'PENDING' ? 1 : 2;
        return priority(a) - priority(b) || new Date(a.start_datetime) - new Date(b.start_datetime);
      });

      setTasks(activeUnits);
      const notesObj = {};
      activeUnits.forEach(t => { notesObj[t.id] = t.service_notes || ''; });
      setLocalNotes(notesObj);
    } catch (err) {
      console.error('Active Jobs Error:', err);
      toast.error('Failed to load active jobs');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async (task, newStatus) => {
    const toastId = toast.loading(`Updating ${task.plate_number}...`);
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
          actorRole: 'STAFF'
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'Lifecycle service unavailable. No status change was made.');
      toast.success(`Marked as ${newStatus.toUpperCase()}`, { id: toastId });
      return fetchActiveTasks();
    } catch (err) {
      toast.error(err.message || 'Status update failed', { id: toastId });
    }
  };

  const canStartTask = (task) => {
    return startReadiness({
      clockedIn: profile?.is_clocked_in,
      beforePhotos: photoCounts[task.id]?.before || 0,
      startDatetime: task.start_datetime
    }).ok;
  };

  const requestUpdateStatus = (task, newStatus) => {
    openModal({
      title: newStatus === 'COMPLETED' ? 'Finalize Service?' : 'Start Service?',
      message: newStatus === 'COMPLETED' ? 'Confirm this unit has passed service.' : 'Start service for this unit?',
      confirmText: newStatus === 'COMPLETED' ? 'Finish Job' : 'Start Service',
      cancelText: 'Cancel',
      type: newStatus === 'COMPLETED' ? 'success' : 'info',
      onConfirm: () => handleUpdateStatus(task, newStatus)
    });
  };

  const handleSaveNotes = async (taskId) => {
    try {
      const { error } = await supabase.rpc('update_booking_vehicle_service_notes', { p_vehicle_id: taskId, p_notes: localNotes[taskId] ?? '' });
      if (error) throw error;
      toast.success('Notes saved');
      fetchActiveTasks();
    } catch (err) {
      toast.error('Failed to save notes');
    }
  };

  if (loading) return <LoadingState message="Connecting to shop floor..." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader 
        badge="PRODUCTION LINE"
        title="Active Service Units"
        subtitle="Current detailing assignments requiring your technical attention."
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
        {tasks.length > 0 ? (
          tasks.map(task => (
            <div key={task.id} style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '8px', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div
                  onClick={() => navigate(`/staff/job/${task.id}`)}
                  style={{ display: 'flex', gap: '1rem', alignItems: 'center', cursor: 'pointer' }}
                >
                  <div style={{ width: '48px', height: '48px', borderRadius: '4px', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-brand)' }}>
                    <Car size={24} />
                  </div>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: '950', textTransform: 'uppercase' }}>{task.brand} {task.model}</h3>
                    <CustomerContact name={task.customer_name} phone={task.contact_number} compact />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.35rem' }}>
                      <span style={{ background: 'var(--admin-brand)', color: 'var(--admin-text-primary)', padding: '0.15rem 0.45rem', borderRadius: '2px', fontSize: '0.65rem', fontWeight: '950', letterSpacing: '0.5px' }}>
                        {task.plate_number}
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{
                  fontSize: '0.6rem', fontWeight: '950', padding: '0.3rem 0.6rem',
                  borderRadius: '2px', background: task.status === 'IN_PROGRESS' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255,255,255,0.05)',
                  color: task.status === 'IN_PROGRESS' ? '#f59e0b' : '#8E9196', border: '1px solid currentColor', textTransform: 'uppercase'
                }}>
                  {task.status}
                </div>
              </div>

              <div style={{ background: 'var(--admin-bg)', padding: '1rem', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.03)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {task.services?.map((s, i) => (
                    <span key={i} style={{ fontSize: '0.65rem', fontWeight: '900', color: 'var(--admin-text-primary)', background: 'var(--admin-card)', padding: '0.25rem 0.5rem', borderRadius: '2px', border: '1px solid var(--admin-border)' }}>{s.service_name}</span>
                  ))}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
                <PhotoProofUploader
                  bookingId={task.booking_id}
                  bookingVehicleId={task.id}
                  phase="before"
                  disabled={['IN_PROGRESS', 'COMPLETED'].includes(task.status?.toUpperCase())}
                  compact
                  onCountChange={(count) => setPhotoCounts(prev => ({ ...prev, [task.id]: { ...(prev[task.id] || {}), before: count } }))}
                />
                {task.status?.toUpperCase() === 'IN_PROGRESS' && (
                  <PhotoProofUploader
                    bookingId={task.booking_id}
                    bookingVehicleId={task.id}
                    phase="after"
                    compact
                    onCountChange={(count) => setPhotoCounts(prev => ({ ...prev, [task.id]: { ...(prev[task.id] || {}), after: count } }))}
                  />
                )}
              </div>

              <div style={{ position: 'relative' }}>
                <textarea
                  value={localNotes[task.id] || ''}
                  onChange={(e) => setLocalNotes({ ...localNotes, [task.id]: e.target.value })}
                  placeholder="Technical observations..."
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-no-auto-capitalize=""
                  style={{ width: '100%', minHeight: '80px', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '1rem', color: 'var(--admin-text-primary)', fontSize: '0.85rem', outline: 'none', resize: 'none' }}
                />
                <button onClick={() => confirmThen({ title: 'Save notes?', message: 'The notes are saved to this job for the admin and customer record.', confirmText: 'Save notes' }, () => handleSaveNotes(task.id))} style={{ position: 'absolute', bottom: '0.5rem', right: '0.5rem', background: 'var(--admin-brand)', border: 'none', borderRadius: '4px', padding: '0.4rem', cursor: 'pointer', color: 'var(--admin-text-primary)' }}>
                  <Save size={14} />
                </button>
              </div>

              {SHOW_START_SERVICE_ACTIONS && ['PENDING', 'SCHEDULED', 'CONFIRMED'].includes(task.status?.toUpperCase()) && (
                <StartChecklist
                  taskId={task.id}
                  clockedIn={profile?.is_clocked_in}
                  beforePhotos={photoCounts[task.id]?.before || 0}
                  startDatetime={task.start_datetime}
                />
              )}
              <div style={{ display: 'flex', gap: '1rem' }}>
                {SHOW_START_SERVICE_ACTIONS && ['PENDING', 'SCHEDULED', 'CONFIRMED'].includes(task.status?.toUpperCase()) && (
                  <button onClick={() => requestUpdateStatus(task, 'IN_PROGRESS')} disabled={!canStartTask(task)} title={!profile?.is_clocked_in ? 'Clock in before starting.' : (photoCounts[task.id]?.before || 0) < 1 ? 'Upload an intake photo first.' : new Date(task.start_datetime).getTime() > Date.now() ? 'Available at the scheduled start time.' : undefined} style={{ flex: 1, padding: '0.85rem', background: canStartTask(task) ? '#E61E2A' : 'var(--admin-border)', color: canStartTask(task) ? 'white' : 'var(--admin-text-secondary)', border: 'none', borderRadius: '4px', fontWeight: '950', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', cursor: canStartTask(task) ? 'pointer' : 'not-allowed', textTransform: 'uppercase' }}>
                    <Play size={16} /> Start Service
                  </button>
                )}
                {task.status?.toUpperCase() === 'IN_PROGRESS' && (
                  <button onClick={() => requestUpdateStatus(task, 'COMPLETED')} disabled={!profile?.is_clocked_in || (photoCounts[task.id]?.after || 0) < 1} style={{ flex: 1, padding: '0.85rem', background: profile?.is_clocked_in && (photoCounts[task.id]?.after || 0) > 0 ? 'var(--status-success)' : 'var(--admin-border)', color: profile?.is_clocked_in && (photoCounts[task.id]?.after || 0) > 0 ? 'var(--admin-text-primary)' : 'var(--admin-text-secondary)', border: 'none', borderRadius: '4px', fontWeight: '950', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', cursor: profile?.is_clocked_in && (photoCounts[task.id]?.after || 0) > 0 ? 'pointer' : 'not-allowed', textTransform: 'uppercase' }}>
                    <CheckCircle2 size={16} /> Complete Service
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <div style={{ gridColumn: '1/-1', padding: '10rem', textAlign: 'center', opacity: 0.1 }}>
            <ClipboardList size={64} style={{ margin: '0 auto 1.5rem' }} />
            <div style={{ fontSize: '1rem', fontWeight: '950', textTransform: 'uppercase' }}>No Active Units</div>
          </div>
        )}
      </div>
    </div>
  );
};

export default StaffActiveJobs;
