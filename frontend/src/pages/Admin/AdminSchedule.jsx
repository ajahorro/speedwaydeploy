import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { subscribeTable } from '../../lib/realtimeHub';
import { Calendar as CalendarIcon, ShieldAlert, Lock, Zap, CheckCircle2, RotateCw, ChevronDown, ChevronUp, ChevronRight, X, Check, Sliders } from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import toast from '@/lib/toast';
import { logger } from '../../utils/logger';
import { buildLocalDateWindow, buildLocalMonthWindow } from '../../utils/dateTimeUtils';

// Refactored Imports
import { COLORS } from '../../config/constants';
import { useConfig } from '../../context/ConfigContext';
import { segregateBookings } from '../../utils/schedulingUtils';
import SegmentedTimePicker from '../../components/AdminSchedule/SegmentedTimePicker';
import OccupancyShelf from '../../components/AdminSchedule/OccupancyShelf';
import DetailTimeline from '../../components/AdminSchedule/DetailTimeline';
import { AlertTriangle, Info } from 'lucide-react';

import { useUI } from '../../context/UIContext';
import { shopDateString, shopWallToDate } from '../../utils/shopTime';

const AdminSchedule = () => {
  const navigate = useNavigate();
  const { settings } = useConfig();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const { openModal, showToast } = useUI();

  // State: Navigation & Context
  // "Today" and every booking position are read on the shop's clock (Asia/Manila), not the device's.
  const [selectedDate, setSelectedDate] = useState(() => shopDateString(new Date()));
  const [viewDate, setViewDate] = useState(new Date());
  const viewDateRef = useRef(viewDate);
  viewDateRef.current = viewDate;

  // State: Data
  const [bookings, setBookings] = useState([]);
  const [blockedSlots, setBlockedSlots] = useState([]);
  const [allMonthBookings, setAllMonthBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  // State: Blocking Panel
  const hours = Array.from(
    { length: settings.CLOSING_HOUR - settings.OPENING_HOUR + 1 },
    (_, i) => i + settings.OPENING_HOUR
  );

  useEffect(() => {
    fetchMonthData();
  }, [viewDate]);

  useEffect(() => {
    fetchDailyContext();
    // 🛡️ REAL-TIME SYNCHRONIZATION (REQ-ADM-02)
    const stopBookings = subscribeTable({ table: 'bookings' }, () => {
      fetchDailyContext();
      fetchMonthData();
    });
    const stopBlocked = subscribeTable({ table: 'blocked_slots' }, () => {
      fetchDailyContext();
    });

    return () => { stopBookings(); stopBlocked(); };
  }, [selectedDate]);

  const fetchMonthData = async () => {
    try {
      const monthWindow = buildLocalMonthWindow(viewDateRef.current);

      const { data, error } = await supabase
        .from('bookings')
        .select('start_datetime')
        .gte('start_datetime', monthWindow.startIso)
        .lt('start_datetime', monthWindow.endIso)
        .not('status', 'ilike', 'cancelled');

      if (error) throw error;
      setAllMonthBookings(data || []);
    } catch (err) {
      logger.error('Month Fetch Error', err);
    }
  };

  const fetchDailyContext = async () => {
    setLoading(true);
    try {
      await flagOverdueBookings();

      // 🛡️ 3-DAY BUFFER: Fetch yesterday, today, and tomorrow to capture any timezone shifts

      // Keep the day window anchored to local midnight boundaries. Using UTC
      // "Z" values here shifts a booking by the browser offset and drags it
      // into the wrong slot on the calendar.
      const fetchStart = shopWallToDate(selectedDate, -24).toISOString();
      const fetchEnd = shopWallToDate(selectedDate, 48).toISOString();

      const { data: bookingsRaw, error: bookingsError } = await supabase
        .from('bookings')
        .select(`
          *,
          customer:profiles!bookings_customer_id_fkey(full_name, email),
          vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services(service_name))
        `)
        .lte('start_datetime', fetchEnd)
        .gte('end_datetime', fetchStart)
        .not('status', 'ilike', 'cancelled');

      if (bookingsError) throw bookingsError;

      // 🛡️ MANUAL PROFILE RESOLUTION
      const bookingsData = [];
      if (bookingsRaw && bookingsRaw.length > 0) {
        for (const b of bookingsRaw) {
          if (!b.customer_id) {
            bookingsData.push({ ...b, customer: { full_name: b.customer_name || 'System/Guest User', email: b.customer_email || null } });
            continue;
          }

          const { data: profile } = await supabase
            .from('profiles')
            .select('full_name, email, phone_number')
            .eq('id', b.customer_id)
            .maybeSingle();
          bookingsData.push({ ...b, customer: profile || { full_name: b.customer_name || 'System/Guest User', email: b.customer_email || null } });
        }
      }

      const { data: blocksData, error: blocksError } = await supabase
        .from('blocked_slots')
        .select('*')
        .eq('block_date', selectedDate);

      if (blocksError) throw blocksError;

      setBookings(bookingsData || []);
      setBlockedSlots(blocksData || []);
    } catch (err) {
      logger.error('Daily Sync Error', err);
      toast.error('Failed to synchronize schedule');
    } finally {
      setLoading(false);
    }
  };

  /**
   * 🛡️ THE 24-HOUR RULE — delegated to the database, never re-implemented here.
   *
   * This used to be a THIRD copy of the no-show sweep (alongside the DB lifecycle
   * and the backend worker), and all three disagreed. This one:
   *   * set `needs_attention: true`, which is the DOUBLE-COUNT — a no-show then
   *     appeared under both "No-Show" AND "Flagged for Review";
   *   * always set `refund_status: 'QUEUED'` even when no money was ever paid;
   *   * measured the 1-hour grace in the BROWSER's clock, so an admin whose
   *     machine is 10 minutes fast flagged bookings the server did not;
   *   * sent the no-show email from the client, so the email could be skipped
   *     entirely by closing the tab.
   *
   * `run_no_show_lifecycle()` is now the ONLY implementation: it flags at
   * start_datetime + 1h and auto-cancels at +25h, on the server's clock, and the
   * backend worker sends the notifications. This call exists only to make the
   * admin's Refresh button push the sweep immediately instead of waiting for the
   * next scheduled run — a convenience, never the control.
   *
   * Best-effort: if the RPC is not deployed yet the schedule page must still
   * render. A failed sweep is recoverable; a broken calendar is not.
   */
  const flagOverdueBookings = async () => {
    const { error } = await supabase.rpc('run_no_show_lifecycle');
    if (error) {
      logger.warn('No-show lifecycle sweep unavailable; the scheduled server sweep will still run.', error);
    }
  };

  const handleDeleteBlock = (blockId, block) => {
    if (!blockId) return;
    openModal({
      title: 'Lift Schedule Restriction?',
      message: `Remove the ${block?.start_time ? 'time-window' : 'full-day'} restriction for ${selectedDate}?`,
      confirmText: 'Lift Restriction',
      cancelText: 'Keep Restriction',
      type: 'warning',
      onConfirm: async () => {
        const { error } = await supabase.from('blocked_slots').delete().eq('id', blockId);
        if (error) {
          logger.error('Restriction Delete Error', error);
          toast.error('Could not lift the schedule restriction.');
          return;
        }
        setBlockedSlots(current => current.filter(item => item.id !== blockId));
        toast.success('Schedule restriction lifted.');
      }
    });
  };

  const getBookingsForHour = (hour) => {
    const hourStart = shopWallToDate(selectedDate, hour);
    const hourEnd = shopWallToDate(selectedDate, hour + 1);

    return bookings.filter(b => {
      const bStart = new Date(b.start_datetime);
      const bEnd = new Date(b.end_datetime);
      return bEnd > hourStart && bStart < hourEnd;
    });
  };

  const getBlockForHour = (hour) => {
    return blockedSlots.find(block => {
      if (!block.start_time) return true; // NULL start_time = whole-day block
      const [sh] = block.start_time.split(':').map(Number);
      const [eh] = block.end_time.split(':').map(Number);
      return hour >= sh && hour < eh;
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem', maxWidth: '1600px', margin: '0 auto' }}>
      <PageHeader
        badge="STUDIO"
        title="STUDIO CALENDAR"
        subtitle="Track bay utilization and live service flow."
        onRefresh={fetchDailyContext}
      >
        <button
          onClick={() => { fetchDailyContext(); fetchMonthData(); }}
          title="Refresh schedule data"
          style={{ background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)', padding: '0.6rem', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <RotateCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </PageHeader>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '350px 1fr', gap: '2rem', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', ...(isMobile ? {} : { position: 'sticky', top: 'calc(var(--app-shell-header-height, 76px) + 1rem)', alignSelf: 'start' }) }}>
          <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem', borderBottom: '1px solid var(--admin-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <CalendarIcon size={18} color="var(--admin-brand)" />
                <span style={{ fontWeight: '950', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
                  {viewDate.toLocaleString('default', { month: 'long' })} {viewDate.getFullYear()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => { const d = new Date(viewDate); d.setMonth(d.getMonth() - 1); setViewDate(d); }}
                  style={{ background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer' }}
                >&lsaquo;</button>
                <button
                  onClick={() => { const d = new Date(viewDate); d.setMonth(d.getMonth() + 1); setViewDate(d); }}
                  style={{ background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer' }}
                >&rsaquo;</button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', background: 'rgba(0,0,0,0.2)' }}>
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <div key={i} style={{ textAlign: 'center', fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', padding: '0.75rem 0' }}>{d}</div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '1px', background: 'var(--admin-border)' }}>
              {(() => {
                const today = shopDateString(new Date());
                const year = viewDate.getFullYear();
                const month = viewDate.getMonth();
                const firstDay = new Date(year, month, 1).getDay();
                const daysInMonth = new Date(year, month + 1, 0).getDate();
                const cells = [];

                for (let i = 0; i < firstDay; i++) cells.push(<div key={`empty-${i}`} style={{ background: 'var(--admin-card)', height: '50px' }} />);

                for (let day = 1; day <= daysInMonth; day++) {
                  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const isToday = dateStr === today;
                  const isSelected = dateStr === selectedDate;
                  const hasBookings = allMonthBookings.some(b => {
                    return shopDateString(b.start_datetime) === dateStr;
                  });

                  cells.push(
                    <div
                      key={dateStr}
                      onClick={() => {
                        setSelectedDate(dateStr);
                        if (new Date(dateStr).getMonth() !== viewDate.getMonth()) setViewDate(new Date(dateStr));
                      }}
                      style={{
                        background: isSelected ? 'rgba(255,255,255,0.05)' : 'var(--admin-card)',
                        height: '50px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '0.85rem',
                        fontWeight: '900',
                        color: isSelected || isToday ? 'var(--admin-text-primary)' : 'var(--admin-text-secondary)',
                        position: 'relative',
                        border: isSelected ? '2px solid var(--admin-brand)' : isToday ? '1px solid rgba(230,30,42,0.4)' : 'none'
                      }}
                    >
                      {day}
                      {hasBookings && (
                        <div style={{ position: 'absolute', bottom: '8px', width: '4px', height: '4px', borderRadius: '50%', background: 'var(--admin-brand)' }} />
                      )}
                    </div>
                  );
                }
                return cells;
              })()}
            </div>
          </div>

          <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem' }}>
              <ShieldAlert size={16} color="var(--admin-brand)" />
              <h4 style={{ margin: 0, fontSize: '0.7rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1px' }}>Active Restrictions</h4>
            </div>
            {blockedSlots.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {blockedSlots.map(block => (
                  <div key={block.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(230,30,42,0.05)', padding: '0.75rem', borderRadius: '4px', border: '1px solid rgba(230,30,42,0.1)' }}>
                    <div>
                      <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>{block.reason || 'MAINTENANCE'}</p>
                      <p style={{ margin: 0, fontSize: '0.6rem', color: 'var(--admin-text-secondary)', fontWeight: '700' }}>
                        {block.start_time ? `${block.start_time} - ${block.end_time}` : 'FULL DAY BLOCK'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ margin: '1rem 0', textAlign: 'center', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', opacity: 0.5 }}>No Active Blocks</p>
            )}
          </div>

        </div>

        <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '4px', ...(isMobile ? { overflow: 'hidden' } : { overflowY: 'auto', overflowX: 'hidden', maxHeight: 'calc(100vh - var(--app-shell-header-height, 76px) - 2rem)', overscrollBehavior: 'contain' }) }}>
          <div style={{ padding: '1.5rem' }}>
            <OccupancyShelf
              bookings={bookings}
              onBookingClick={(id) => navigate(`/admin/bookings/${id}`)}
              config={settings}
            />

            {loading ? <LoadingState message="Syncing timeline..." /> : (
              <>
                {bookings.length === 0 && blockedSlots.length === 0 && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '1rem',
                    padding: '0.85rem 1.25rem',
                    background: 'rgba(16, 185, 129, 0.05)',
                    border: '1px solid rgba(16, 185, 129, 0.2)',
                    borderRadius: '6px',
                    marginBottom: '1rem'
                  }}>
                    <CheckCircle2 size={18} color="var(--status-success)" style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: '950', color: 'var(--status-success)', textTransform: 'uppercase', letterSpacing: '1px' }}>Zero Administrative Records</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: '600', marginLeft: '0.75rem' }}>This day is clear. No bookings or restrictions are scheduled.</span>
                    </div>
                  </div>
                )}
                <DetailTimeline
                  hours={hours}
                  selectedDate={selectedDate}
                  getBookingsForHour={getBookingsForHour}
                  getBlockForHour={getBlockForHour}
                  onBookingClick={(id) => navigate(`/admin/bookings/${id}`)}
                  onDeleteBlock={handleDeleteBlock}
                  config={settings}
                />
              </>
            )}
          </div>
        </div>
      </div>

    </div>
  );
};

export default AdminSchedule;
