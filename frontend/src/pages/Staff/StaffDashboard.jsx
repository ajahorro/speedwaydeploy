import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { subscribeTables } from '../../lib/realtimeHub';
import { useNavigate } from 'react-router-dom';
import {
  ClipboardList, Clock, CheckCircle2, AlertCircle,
  Car, ArrowRight, TrendingUp, Bell, LogIn
} from 'lucide-react';
import toast from '@/lib/toast';
import { useAuth } from '../../hooks/useAuth';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import { BACKEND_URL } from '../../config/api';
import { loadPreferences } from '../../utils/preferenceStore';
import { playJobAssignmentChime } from '../../utils/jobAssignmentChime';
import { isNotificationActionable, isRedundantStaffTechnicianAssignment } from '../../utils/notificationRouting';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import CustomerContact from '../../components/Staff/CustomerContact';
const StaffDashboard = () => {
  const { confirmThen } = useConfirmAction();
  const { profile, toggleShift } = useAuth();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ pending: 0, active: 0, completed: 0 });
  const [broadcasts, setBroadcasts] = useState([]);
  const [shiftTimer, setShiftTimer] = useState('OFF DUTY');
  const [isClockingIn, setIsClockingIn] = useState(false);
  const [soundHapticChime, setSoundHapticChime] = useState(false);
  const soundHapticChimeRef = useRef(false);
  const knownTaskIdsRef = useRef(new Set());
  const hasLoadedTasksRef = useRef(false);
  useEffect(() => {
    soundHapticChimeRef.current = soundHapticChime;
  }, [soundHapticChime]);

  useEffect(() => {
    let mounted = true;
    loadPreferences(profile?.id)
      .then((preferences) => {
        if (mounted) setSoundHapticChime(Boolean(preferences.soundHapticChime));
      })
      .catch(() => {
        if (mounted) setSoundHapticChime(false);
      });
    return () => { mounted = false; };
  }, [profile?.id]);

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

  const fetchAssignedTasks = useCallback(async () => {
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

      const allVehicleTasks = (data || []).flatMap(b => 
        (b.vehicles || []).map(v => ({
          ...v,
          booking_id: b.id,
          booking_status: b.status,
          customer_name: b.customer_name,
          contact_number: b.contact_number,
          start_datetime: b.start_datetime
        }))
      ).filter(v => v.status?.toUpperCase() !== 'COMPLETED');
      allVehicleTasks.sort((a, b) => {
        const priority = (task) => task.status?.toUpperCase() === 'IN_PROGRESS' ? 0 : task.status?.toUpperCase() === 'PENDING' ? 1 : 2;
        return priority(a) - priority(b) || new Date(a.start_datetime) - new Date(b.start_datetime);
      });

      const newPendingAssignment = hasLoadedTasksRef.current && allVehicleTasks.some((task) =>
        !knownTaskIdsRef.current.has(task.id)
          && ['PENDING', 'SCHEDULED'].includes(task.status?.toUpperCase())
      );
      if (newPendingAssignment && soundHapticChimeRef.current) playJobAssignmentChime();
      knownTaskIdsRef.current = new Set(allVehicleTasks.map((task) => task.id));
      hasLoadedTasksRef.current = true;

      setTasks(allVehicleTasks);
      
      const pending = allVehicleTasks.filter(t => t.status?.toUpperCase() === 'PENDING').length;
      const active = allVehicleTasks.filter(t => t.status?.toUpperCase() === 'IN_PROGRESS').length;
      const completed = allVehicleTasks.filter(t => t.status?.toUpperCase() === 'COMPLETED').length;
      setStats({ pending, active, completed });

      // Fetch System Broadcasts & Announcements
      const { data: notifData } = await supabase
        .from('notifications')
        .select('title, message, created_at')
        .eq('user_id', profile.id)
        .order('created_at', { ascending: false })
        .limit(5);

      setBroadcasts((notifData || []).filter((notification) =>
        isNotificationActionable(notification)
        && !isRedundantStaffTechnicianAssignment(notification)
        && notification.notification_type !== 'MESSAGE_RECEIVED'
        && !notification.title?.toLowerCase().includes('new message')
      ));
    } catch (err) {
      console.error('Task Fetch Error:', err);
      toast.error('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    fetchAssignedTasks();

    // REQ-SYS-05: Real-time synchronization
    const stopRealtime = subscribeTables([
      { table: 'bookings', filter: `staff_id=eq.${profile?.id}` },
      { table: 'booking_vehicles', filter: `staff_id=eq.${profile?.id}` },
      { table: 'notifications', filter: `user_id=eq.${profile?.id}` }
    ], fetchAssignedTasks);

    return () => { stopRealtime(); };
  }, [fetchAssignedTasks, profile?.id]);

  const handleClockIn = async () => {
    if (!profile?.id || typeof toggleShift !== 'function' || profile.is_clocked_in || isClockingIn) return;
    setIsClockingIn(true);
    try {
      await toggleShift(true);
    } finally {
      setIsClockingIn(false);
    }
  };

  if (loading) return <LoadingState message="Loading your assignments..." />;

  const badgeStyle = (status) => {
    const s = status?.toUpperCase();
    return {
      fontSize: '0.72rem',
      fontWeight: '950',
      padding: '0.35rem 0.75rem',
      borderRadius: 'var(--admin-radius)',
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

        <div style={{ background: 'var(--admin-card)', boxShadow: 'var(--admin-card-shadow)', padding: '1.25rem', borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)', minWidth: isMobile ? 0 : '320px', width: isMobile ? '100%' : undefined, maxWidth: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ fontSize: '0.72rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <TrendingUp size={14} color="var(--status-success)" /> Shift Tracker
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: '1.1rem', fontWeight: '950', color: stats.active > 0 ? 'var(--status-warning)' : 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>
                {stats.active > 0 ? `${stats.active} In Progress` : 'No active job'}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: '950', textTransform: 'uppercase', marginTop: '0.25rem' }}>Active Job</div>
            </div>
            <div style={{ width: '1px', height: '30px', background: 'var(--admin-border)' }}></div>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: '1.1rem', fontWeight: '950', color: profile?.is_clocked_in ? 'var(--status-success)' : 'var(--admin-brand)', textTransform: 'uppercase' }}>
                {shiftTimer}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: '950', textTransform: 'uppercase', marginTop: '0.25rem' }}>Current Shift</div>
            </div>
          </div>
          {!profile?.is_clocked_in && (
            <button
              type="button"
              onClick={() => confirmThen({ title: 'Start your shift?', message: 'You will be marked on duty and can receive assignments.', confirmText: 'Start shift' }, handleClockIn)}
              disabled={!profile?.id || isClockingIn}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', width: '100%', padding: '0.75rem 1rem', background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: 'none', borderRadius: 'var(--admin-radius)', fontWeight: '900', textTransform: 'uppercase', cursor: isClockingIn ? 'wait' : 'pointer', opacity: !profile?.id || isClockingIn ? 0.65 : 1 }}
            >
              <LogIn size={16} /> {isClockingIn ? 'Clocking In...' : 'Clock In'}
            </button>
          )}
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
              <button
                key={task.id}
                type="button"
                onClick={() => navigate(`/staff/job/${task.id}`)}
                style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', width: '100%', textAlign: 'left', background: 'var(--admin-card)', boxShadow: 'var(--admin-card-shadow)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', padding: isMobile ? '1rem' : '1.25rem 1.5rem', color: 'var(--admin-text-primary)', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: '1 1 240px', minWidth: 0 }}>
                  <div style={{ width: '48px', height: '48px', flexShrink: 0, borderRadius: 'var(--admin-radius)', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-brand)' }}>
                    <Car size={24} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '1rem', fontWeight: 950, textTransform: 'uppercase', overflowWrap: 'anywhere' }}>{task.brand} {task.model}</div>
                    <div style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--admin-text-secondary)', marginTop: '0.2rem', overflowWrap: 'anywhere' }}>
                      {task.plate_number || 'No plate'} · {(task.services || []).map((s) => s.service_name).join(', ') || 'No services'}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--admin-text-secondary)', fontWeight: 900, textTransform: 'uppercase' }}>
                    {new Date(task.start_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div style={badgeStyle(task.status)}>{task.status?.replace(/_/g, ' ').toUpperCase()}</div>
                  <ArrowRight size={16} color="var(--admin-text-secondary)" />
                </div>
              </button>
            ))
          ) : (
            <div style={{ background: 'var(--admin-card)', boxShadow: 'var(--admin-card-shadow)', border: '1px dashed var(--admin-border)', borderRadius: 'var(--admin-radius)', textAlign: 'center', padding: '2rem 1.5rem', minHeight: '180px', maxHeight: '220px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <ClipboardList size={36} style={{ marginBottom: '1rem', opacity: 0.25, color: 'var(--admin-text-secondary)' }} />
              <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: '800', color: 'var(--admin-text-primary)' }}>No active assignments</h3>
              <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.75rem', fontWeight: '600', marginTop: '0.4rem' }}>Vehicles assigned to you will appear here.</p>
            </div>
          )}
        </div>

        <div style={{ width: isMobile ? '100%' : '320px', display: 'flex', flexDirection: 'column', gap: '2rem', position: 'sticky', top: '100px' }}>
          {/* System Broadcasts & Announcements */}
          <div style={{ background: 'var(--admin-card)', boxShadow: 'var(--admin-card-shadow)', borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)', overflow: 'hidden' }}>
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
                      <div style={{ fontSize: '0.72rem', fontWeight: '900', color: 'var(--admin-text-secondary)' }}>
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
            <div style={{ padding: '1.25rem', background: 'rgba(var(--admin-brand-rgb, 169, 27, 24), 0.05)', border: '1px solid rgba(var(--admin-brand-rgb, 169, 27, 24), 0.15)', borderRadius: 'var(--admin-radius)', textAlign: 'center' }}>
              <Clock size={24} color="var(--admin-brand)" style={{ margin: '0 auto 0.75rem' }} />
              <div style={{ fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-brand)', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Not Clocked In</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: '700' }}>Open Duty &amp; Shift to clock in and enable service controls.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StaffDashboard;
