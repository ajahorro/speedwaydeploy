import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { BarChart2, CalendarDays, CheckCircle2, Clock, Wrench } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// The shop-wide bookings report (and its assistant) load only when the tab is opened.
const StaffBookingsReport = lazy(() => import('../../features/staff-reports/StaffBookingsReport'));

const TZ = 'Asia/Manila';
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '');
const dayLabel = (day) => new Date(`${day}T12:00:00+08:00`).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
const dateTimeLabel = (iso) => (iso ? new Date(iso).toLocaleString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const statusWords = (status) => {
  const key = String(status || '').toUpperCase();
  if (['COMPLETED', 'RELEASED'].includes(key)) return 'Finished';
  if (['IN_PROGRESS', 'ONGOING'].includes(key)) return 'In progress';
  return 'Waiting to start';
};

const cardStyle = { background: 'var(--admin-card)', boxShadow: 'var(--admin-card-shadow)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', padding: '1.25rem' };
const smallLabel = { fontSize: '0.68rem', fontWeight: 900, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' };

const Stat = ({ icon: Icon, label, value }) => (
  <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
    <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(var(--admin-brand-rgb), 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <Icon size={18} color="var(--admin-brand)" />
    </div>
    <div>
      <div style={{ fontSize: '1.6rem', fontWeight: 950, lineHeight: 1.1, color: 'var(--admin-text-primary)' }}>{value}</div>
      <div style={smallLabel}>{label}</div>
    </div>
  </div>
);

const ScheduleList = ({ title, rows }) => (
  <div style={cardStyle}>
    <div style={{ ...smallLabel, marginBottom: '0.75rem' }}>{title}</div>
    {rows.length === 0 ? (
      <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontWeight: 700, fontSize: '0.85rem' }}>No vehicles assigned to you for this day.</p>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {rows.map((row, index) => (
          <div key={`${row.booking}-${row.plate}-${index}`} style={{ border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', padding: '0.75rem 0.9rem', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '0.5rem' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 900, color: 'var(--admin-text-primary)', fontSize: '0.9rem' }}>{timeOf(row.start)} · {row.vehicle || 'Vehicle'} {row.plate ? `(${row.plate})` : ''}</div>
              <div style={{ color: 'var(--admin-text-secondary)', fontSize: '0.78rem', fontWeight: 700, marginTop: '0.2rem' }}>
                {(row.services || []).join(', ') || 'No services listed'} · Booking #{row.booking}{row.customer ? ` · ${row.customer}` : ''}
              </div>
            </div>
            <div style={{ fontWeight: 900, fontSize: '0.75rem', color: 'var(--admin-brand)', textTransform: 'uppercase' }}>{statusWords(row.status)}</div>
          </div>
        ))}
      </div>
    )}
  </div>
);

/**
 * Staff reports (only when an administrator turned reports on for this account).
 *  - All bookings: every booking report for the whole shop, plus the bookings assistant. Bookings only: no money,
 *    payments, prices, or customer contact details (the database functions behind it leave them out).
 *  - My work: this technician's own vehicles for today and tomorrow, their job counts, and the last jobs they finished.
 */
const StaffReports = () => {
  const { profile } = useAuth();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('staff_report');
    if (error) setDenied(true);
    else { setReport(data); setDenied(false); }
    setLoading(false);
  }, []);

  useEffect(() => { if (profile?.id) load(); }, [profile?.id, load]);

  if (loading) return <LoadingState message="Preparing your report..." />;

  if (denied || !report) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <PageHeader badge="MY REPORT" title="Reports" subtitle="Booking reports for the shop." />
        <div style={{ ...cardStyle, color: 'var(--admin-text-secondary)', fontWeight: 700 }}>
          Reports are not turned on for your account. Ask an administrator if you need them.
        </div>
      </div>
    );
  }

  const counts = report.counts || {};
  const schedule = report.schedule || [];
  const today = schedule.filter((row) => row.day === report.day);
  const tomorrow = schedule.filter((row) => row.day === report.tomorrow);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem' }}>
      <PageHeader badge="REPORTS" title="Reports" subtitle="Booking reports for the whole shop, and your own work. Payments, prices, and customer contact details are not shown." onRefresh={load} />

      <div className="ui-root">
      <Tabs defaultValue="bookings" className="gap-6">
        <TabsList>
          <TabsTrigger value="bookings">All bookings</TabsTrigger>
          <TabsTrigger value="mine">My work</TabsTrigger>
        </TabsList>
        <TabsContent value="bookings">
          <Suspense fallback={<LoadingState message="Opening the bookings report..." />}>
            <StaffBookingsReport />
          </Suspense>
        </TabsContent>
        <TabsContent value="mine" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '1rem' }}>
        <Stat icon={CalendarDays} label="Vehicles today" value={counts.today_total ?? 0} />
        <Stat icon={CheckCircle2} label="Finished today" value={counts.today_completed ?? 0} />
        <Stat icon={Wrench} label="In progress now" value={counts.today_in_progress ?? 0} />
        <Stat icon={Clock} label="Still to start today" value={counts.today_pending ?? 0} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '1rem' }}>
        <Stat icon={BarChart2} label="Finished this week" value={counts.week_completed ?? 0} />
        <Stat icon={BarChart2} label="Finished this month" value={counts.month_completed ?? 0} />
        <Stat icon={BarChart2} label="Finished all time" value={counts.all_completed ?? 0} />
      </div>

      <ScheduleList title={`Today · ${dayLabel(report.day)}`} rows={today} />
      <ScheduleList title={`Tomorrow · ${dayLabel(report.tomorrow)}`} rows={tomorrow} />

      <div style={cardStyle}>
        <div style={{ ...smallLabel, marginBottom: '0.75rem' }}>Last finished jobs</div>
        {(report.recent || []).length === 0 ? (
          <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontWeight: 700, fontSize: '0.85rem' }}>You have not finished a job yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {report.recent.map((row, index) => (
              <div key={`${row.booking}-${index}`} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '0.5rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.5rem' }}>
                <span style={{ fontWeight: 800, color: 'var(--admin-text-primary)', fontSize: '0.85rem' }}>{row.vehicle || 'Vehicle'} {row.plate ? `(${row.plate})` : ''} — {(row.services || []).join(', ') || 'No services listed'}</span>
                <span style={{ color: 'var(--admin-text-secondary)', fontSize: '0.78rem', fontWeight: 700 }}>{dateTimeLabel(row.finished)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
        </TabsContent>
      </Tabs>
      </div>
    </div>
  );
};

export default StaffReports;
