import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { subscribeTables } from '../../lib/realtimeHub';
import { formatBookingDate, formatBookingTime, getStatusColor } from '../../utils/bookingHelpers';
import {
  CreditCard, Users, AlertCircle,
  ChevronRight, ShieldAlert, RefreshCcw, CheckCircle
} from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import { useUI } from '../../context/UIContext';
import { logger } from '../../utils/logger';
import toast from '@/lib/toast';
import { BACKEND_URL } from '../../config/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { fetchBookingLedgers, fetchSalesReport } from '../../services/ledgerService';

// MEMOIZED SUB-COMPONENTS: Prevent entire dashboard from re-rendering on single metric change
const AttentionCard = React.memo(({ count, label, icon: Icon, color, bg, onClick }) => {
  const isZero = Number(count || 0) === 0;
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
      className="attention-card cursor-pointer flex-row items-center gap-3.5 px-4 py-4 transition-all hover:-translate-y-0.5 hover:border-[var(--admin-brand)]"
      style={{ borderColor: isZero ? undefined : color + '55', background: 'var(--admin-card)' }}
    >
      <div className="flex size-11 shrink-0 items-center justify-center rounded-full border" style={{ background: isZero ? 'rgba(148,163,184,0.08)' : bg, color, opacity: isZero ? 0.65 : 1, borderColor: isZero ? 'rgba(148,163,184,0.18)' : color + '55' }}>
        <Icon size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-2xl font-black leading-tight" style={{ color: isZero ? 'var(--admin-text-secondary)' : 'var(--admin-text-primary)' }}>{count}</div>
        <div className="mt-0.5 text-xs font-bold capitalize" style={{ color: isZero ? 'var(--admin-text-secondary)' : 'var(--admin-text-primary)' }}>{label}</div>
      </div>
      <ChevronRight size={18} style={{ color: 'var(--admin-text-secondary)', opacity: isZero ? 0.5 : 1 }} />
    </Card>
  );
});

// Open bookings that still have a vehicle without a technician (each booking once).
const fetchBookingsWithUnassignedVehicles = async () => {
  const { data } = await supabase
    .from('booking_vehicles')
    .select('booking_id, bookings!inner(id, customer_id, customer_name, start_datetime, status)')
    .is('staff_id', null)
    .not('bookings.status', 'ilike', 'cancelled')
    .not('bookings.status', 'ilike', 'completed')
    .not('bookings.status', 'ilike', 'released')
    .not('bookings.status', 'ilike', 'in_progress')
    .not('bookings.status', 'ilike', 'ongoing')
    .not('bookings.status', 'ilike', 'FLAGGED_NOSHOW')
    .not('bookings.status', 'ilike', 'NO_SHOW')
    .limit(1000);
  const seen = new Map();
  for (const row of data || []) if (row.bookings && !seen.has(row.booking_id)) seen.set(row.booking_id, row.bookings);
  return [...seen.values()].sort((a, b) => new Date(a.start_datetime) - new Date(b.start_datetime));
};

const getQueueStatusStyle = status => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'scheduled') return { background: 'rgba(59, 130, 246, 0.1)', border: 'rgba(59, 130, 246, 0.28)', color: 'var(--status-info)' };
  if (normalized === 'confirmed') return { background: 'rgba(16, 185, 129, 0.1)', border: 'rgba(16, 185, 129, 0.28)', color: 'var(--status-success)' };
  return { background: 'rgba(168, 85, 247, 0.1)', border: 'rgba(168, 85, 247, 0.28)', color: 'var(--status-accent)' };
};

const AdminDashboard = () => {
  const navigate = useNavigate();
  const { openModal } = useUI();

  // BATCHED STATE
  const [state, setState] = useState({
    loading: true,
    stats: {
      todayBookings: 0,
      totalBookings: 0,
      totalRevenue: 0,
      pendingPayments: 0,
      flaggedBookings: 0,
      unassignedBookings: 0,
      overdueServices: 0,
      refundRequests: 0,
      releaseBay: 0,
      successRate: 0,
      shopLoad: 0
      ,lifecycle: { pending: 0, inProgress: 0, completed: 0, activeBays: 0 }
    },
    priorityItems: [],
    priorityLoading: true,
    activeQueue: []
  });

  const fetchPriorityQueue = useCallback(async () => {
    try {
      const pItems = [];
      // bookings with at least one vehicle that has no technician
      const unassignedBookings = await fetchBookingsWithUnassignedVehicles();
      const unassignedRaw = unassignedBookings.slice(0, 2);

      for (const item of unassignedRaw || []) {
        const { data: profile } = item.customer_id
          ? await supabase.from('profiles').select('full_name').eq('id', item.customer_id).maybeSingle()
          : { data: null };
        pItems.push({
          id: item.id,
          type: 'STAFF',
          title: profile?.full_name || item.customer_name || 'Unknown',
          sub: `Scheduled for ${formatBookingDate(item.start_datetime)}`,
          color: '#3b82f6'
        });
      }

      const { data: pendingRaw } = await supabase.from('payments').select('id, amount, booking_id').eq('status', 'FOR_VERIFICATION').limit(2);
      for (const item of pendingRaw || []) {
        const { data: booking } = await supabase.from('bookings').select('customer_id, customer_name').eq('id', item.booking_id).maybeSingle();
        if (!booking) continue;
        const { data: profile } = booking.customer_id
          ? await supabase.from('profiles').select('full_name').eq('id', booking.customer_id).maybeSingle()
          : { data: null };
        pItems.push({ id: item.id, type: 'PAYMENT', title: `Verification Needed: ₱${item.amount}`, sub: profile?.full_name || booking.customer_name || 'Unknown', color: 'var(--status-warning)' });
      }

      const { data: rejectedRaw } = await supabase.from('payments').select('id, amount, booking_id').eq('status', 'REJECTED').limit(2);
      for (const item of rejectedRaw || []) {
        const { data: booking } = await supabase.from('bookings').select('customer_id, customer_name').eq('id', item.booking_id).maybeSingle();
        if (!booking) continue;
        const { data: profile } = booking.customer_id
          ? await supabase.from('profiles').select('full_name').eq('id', booking.customer_id).maybeSingle()
          : { data: null };
        pItems.push({ id: item.id, type: 'ALERT', title: `Rejected Payment: ₱${item.amount}`, sub: profile?.full_name || booking.customer_name || 'Unknown', color: 'var(--status-danger)' });
      }

      const { data: overdueRaw } = await supabase.from('bookings').select('id, customer_id, customer_name, start_datetime').eq('status', 'FLAGGED_NOSHOW').limit(2);
      for (const item of overdueRaw || []) {
        const { data: profile } = item.customer_id
          ? await supabase.from('profiles').select('full_name').eq('id', item.customer_id).maybeSingle()
          : { data: null };
        pItems.push({
          id: item.id,
          type: 'NO-SHOW',
          title: `No-Show: ${profile?.full_name || item.customer_name || 'Unknown'}`,
          sub: `Missed ${formatBookingDate(item.start_datetime)} at ${formatBookingTime(item.start_datetime)}`,
          color: 'var(--admin-brand)'
        });
      }

      setState(prev => ({ ...prev, priorityItems: pItems, priorityLoading: false }));
    } catch (err) {
      logger.error('Priority Queue Sync Error', err);
      setState(prev => ({ ...prev, priorityItems: [], priorityLoading: false }));
    }
  }, []);

  const fetchDashboardData = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, priorityLoading: true }));
    fetchPriorityQueue();
    try {
      logger.admin('Synchronizing dashboard intelligence...');
      const today = new Date().toLocaleDateString('en-CA');

      // 1. Today's Bookings
      const { count: todayCount } = await supabase
        .from('bookings')
        .select('*', { count: 'exact', head: true })
        .gte('start_datetime', `${today}T00:00:00`)
        .lte('start_datetime', `${today}T23:59:59`);

      // 2. Total Bookings
      const { count: totalCount } = await supabase
        .from('bookings')
        .select('*', { count: 'exact', head: true });

      // 3. Total Revenue — all-time net revenue from the same ledger report as
      // Financial Reports (net received minus refunds; transfer fees excluded).
      const tomorrow = new Date();
      tomorrow.setHours(24, 0, 0, 0);
      const lifetime = await fetchSalesReport({ from: new Date(2000, 0, 1), to: tomorrow });
      const revenue = Number(lifetime?.net_revenue || 0);

      // 4. Success Rate Calculation
      const { data: allVehicles } = await supabase.from('booking_vehicles').select('status');
      const completed = allVehicles?.filter(v => v.status === 'COMPLETED').length || 0;
      const totalUnits = allVehicles?.length || 1; // Avoid div by zero
      const sRate = Math.round((completed / totalUnits) * 100);

      // 5. Shop Load (Active vs Total assigned)
      const activeUnits = allVehicles?.filter(v => v.status === 'IN_PROGRESS').length || 0;
      const sLoad = Math.round((activeUnits / totalUnits) * 100);
      const normalizedStatuses = (allVehicles || []).map(vehicle => String(vehicle.status || '').toUpperCase());
      // Real vehicle-status lifecycle only. There is no QUALITY_CHECK /
      // READY_FOR_PICKUP / FOR_RELEASE state in the schema — those were dead
      // references that permanently reported 0 and inflated the active-bay count.
      const lifecycle = {
        pending: normalizedStatuses.filter(status => ['QUEUED', 'PENDING'].includes(status)).length,
        inProgress: normalizedStatuses.filter(status => ['IN_PROGRESS', 'ONGOING'].includes(status)).length,
        completed: normalizedStatuses.filter(status => ['COMPLETED', 'RELEASED'].includes(status)).length,
        activeBays: normalizedStatuses.filter(status => ['IN_PROGRESS', 'ONGOING'].includes(status)).length
      };

      // 4. Needs Attention - Pending Payments
      const { count: pendingPay } = await supabase
        .from('payments')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'FOR_VERIFICATION');

      // 5. Needs Attention - Unassigned Bookings
      const unassigned = (await fetchBookingsWithUnassignedVehicles()).length;

      // 6. Needs Attention - Flagged for Review (Rejected Payments)
      const { count: flaggedCount } = await supabase
        .from('payments')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'REJECTED');

      // 7. Needs Attention - No-Show Flagged (REQ-ADM-02)
      const { count: overdue } = await supabase
        .from('bookings')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'FLAGGED_NOSHOW');

      // Completed bookings still occupy a bay until the customer collects the vehicle.
      const { count: releaseBay } = await supabase
        .from('bookings')
        .select('*', { count: 'exact', head: true })
        .in('status', ['completed', 'COMPLETED']);

      // 8. Needs Attention - Refund Requests (REQ-ADM-05)
      const { data: refundData } = await supabase
        .from('bookings')
        .select('id, refund_status')
        .in('status', ['cancelled', 'FLAGGED_NOSHOW']);

      // A refund is owed when the ledger still holds money for the booking.
      const refundCandidates = (refundData || []).filter(b => b.refund_status !== 'PROCESSED');
      const refundLedgers = await fetchBookingLedgers(refundCandidates.map(b => b.id));
      const refundRequestsCount = refundCandidates
        .filter(b => Number(refundLedgers.get(b.id)?.net_settled || 0) > 0)
        .length;

      const { data: activeQueue } = await supabase
        .from('bookings')
        .select('id, customer_name, start_datetime, status, refund_status, vehicles:booking_vehicles(id, vehicle_type, plate_number)')
        .in('status', ['pending', 'scheduled', 'confirmed', 'in_progress', 'ongoing', 'submitted', 'PENDING', 'SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'ONGOING', 'SUBMITTED'])
        .order('start_datetime', { ascending: true })
        .limit(100);
      const visibleActiveQueue = (activeQueue || [])
        .filter(booking => !['QUEUED', 'PROCESSING', 'PROCESSED', 'EMAIL_PENDING'].includes(String(booking.refund_status || '').toUpperCase()))
        .sort((a, b) => {
          const priority = (booking) => ['IN_PROGRESS', 'ONGOING'].includes(String(booking.status || '').toUpperCase()) ? 0 : ['SCHEDULED', 'CONFIRMED'].includes(String(booking.status || '').toUpperCase()) ? 1 : 2;
          return priority(a) - priority(b) || new Date(a.start_datetime) - new Date(b.start_datetime);
        })
        .slice(0, 12);

      setState(prev => ({
        ...prev,
        loading: false,
        stats: {
          todayBookings: todayCount || 0,
          totalBookings: totalCount || 0,
          totalRevenue: revenue,
          pendingPayments: pendingPay || 0,
          flaggedBookings: flaggedCount || 0,
          unassignedBookings: unassigned || 0,
          overdueServices: overdue || 0,
          refundRequests: refundRequestsCount || 0,
          releaseBay: releaseBay || 0,
          successRate: sRate,
          shopLoad: sLoad,
          lifecycle
        },
        activeQueue: visibleActiveQueue
      }));

      logger.admin('Operational intelligence synchronized.');

      // Refund gateway mapped
      window.refundGatewayMappedToastFired = true;
    } catch (err) {
      logger.error('Dashboard Sync Error', err);
      toast.error('Failed to sync live metrics');
      setState(prev => ({ ...prev, loading: false }));
    }
  }, [fetchPriorityQueue]);

  const releaseBooking = (bookingId) => {
    openModal({
      title: 'Release Booking?',
      message: 'The customer has collected the vehicle and the bay can be made available again.',
      confirmText: 'Yes, Release',
      cancelText: 'Keep Completed',
      type: 'success',
      onConfirm: async () => {
        try {
          const response = await fetch(`${BACKEND_URL}/api/bookings/release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bookingId })
          });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error || 'Release failed.');
          toast.success('Booking released from the active queue.');
          fetchDashboardData();
        } catch (error) {
          logger.error('Release Booking Error', error);
          toast.error('Unable to release this booking.');
        }
      }
    });
  };

  useEffect(() => {
    fetchDashboardData();

    // REQ-NFR-05: Realtime subscription for auto-refresh
    const debounceRef = { current: null };
    const debouncedRefresh = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(fetchDashboardData, 500);
    };

    const stopRealtime = subscribeTables([{ table: 'bookings' }, { table: 'payments' }], debouncedRefresh);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      stopRealtime();
    };
  }, [fetchDashboardData]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', animation: 'fadeIn 0.5s ease' }}>
      <PageHeader
        badge="OPERATIONAL OVERVIEW"
        title="Command Center"
        subtitle="Real-time performance metrics and fleet coordination."
        onRefresh={fetchDashboardData}
      />

      {/* Two-column operational overview */}
      <div className="dashboard-columns">
        <section style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <ShieldAlert size={20} color="var(--admin-brand)" />
          <h2 style={{ margin: 0, fontSize: '0.9rem', fontWeight: '950', color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Needs Immediate Attention</h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '0.9rem' }}>
          <AttentionCard
            count={state.stats.pendingPayments}
            label="Pending Verifications"
            icon={CreditCard}
            color="var(--status-warning)"
            bg="rgba(245, 158, 11, 0.1)"
            onClick={() => navigate('/admin/payments')}
          />
          <AttentionCard
            count={state.stats.flaggedBookings}
            label="Flagged for Review"
            icon={ShieldAlert}
            color="var(--status-danger)"
            bg="rgba(239, 68, 68, 0.1)"
            onClick={() => navigate('/admin/bookings?filter=FLAGGED_NOSHOW')}
          />
          <AttentionCard
            count={state.stats.unassignedBookings}
            label="Unassigned Fleets"
            icon={Users}
            color="#3b82f6"
            bg="rgba(59, 130, 246, 0.1)"
            onClick={() => navigate('/admin/bookings?filter=unassigned')}
          />
          <AttentionCard
            count={state.stats.overdueServices}
            label="No-Show Flagged"
            icon={AlertCircle}
            color="var(--admin-brand)"
            bg="rgba(230, 30, 42, 0.1)"
            onClick={() => navigate('/admin/bookings?filter=overdue')}
          />
          <AttentionCard
            count={state.stats.refundRequests}
            label="Refund Requests"
            icon={RefreshCcw}
            color="#f97316"
            bg="rgba(249, 115, 22, 0.1)"
            onClick={() => navigate('/admin/refunds')}
          />
          <AttentionCard
            count={state.stats.releaseBay}
            label="Release Bay"
            icon={CheckCircle}
            color="var(--status-success)"
            bg="rgba(16, 185, 129, 0.1)"
            onClick={() => navigate('/admin/bookings?filter=completed')}
          />
        </div>

        </section>

        <Card className="live-queue-panel" style={{ background: 'var(--admin-card)' }}>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-xs font-black uppercase tracking-widest">
              <span className="size-1.5 rounded-full" style={{ background: 'var(--admin-brand)', animation: 'pulse 1.5s infinite' }} />
              Live Booking Queue
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate('/admin/bookings')} className="text-xs font-extrabold uppercase tracking-wider" style={{ color: 'var(--admin-brand)' }}>
              View all queue
            </Button>
          </CardHeader>
          <CardContent>
            {state.loading ? (
              <div className="py-3 text-xs font-bold" style={{ color: 'var(--admin-text-secondary)' }}>Loading live bookings...</div>
            ) : state.activeQueue.length === 0 ? (
              <div className="py-3 text-xs font-bold" style={{ color: 'var(--admin-text-secondary)' }}>No active bookings right now.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {state.activeQueue.map(booking => {
                  const statusStyle = getQueueStatusStyle(booking.status);
                  return (
                    <div key={booking.id} role="button" tabIndex={0}
                      onClick={() => navigate(`/admin/bookings/${booking.id}`)}
                      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/bookings/${booking.id}`); }}
                      className="queue-row flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-transform hover:translate-x-0.5"
                      style={{ background: statusStyle.background, borderColor: statusStyle.border }}>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-black" style={{ color: 'var(--admin-text-primary)' }}>{booking.customer_name || 'Walk-in Guest'}</div>
                        <div className="text-xs font-bold" style={{ color: 'var(--admin-text-secondary)' }}>{formatBookingDate(booking.start_datetime)} at {formatBookingTime(booking.start_datetime)} · {booking.vehicles?.length || 0} vehicle{booking.vehicles?.length === 1 ? '' : 's'}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="text-[0.6rem] font-black uppercase tracking-wider" style={{ background: statusStyle.background, borderColor: statusStyle.border, color: statusStyle.color }}>{String(booking.status).replace('_', ' ')}</Badge>
                        <ChevronRight size={14} style={{ color: 'var(--admin-text-secondary)' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <style>{`
        .dashboard-columns { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.9fr); gap: 1.25rem; align-items: start; }
        @media (max-width: 1000px) { .dashboard-columns { grid-template-columns: 1fr; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } 100% { opacity: 1; transform: scale(1); } }
      `}</style>
    </div>
  );
};

export default AdminDashboard;
