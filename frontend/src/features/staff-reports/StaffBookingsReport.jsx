import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import toast from '@/lib/toast';
import { FileDown, FileSpreadsheet, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchStaffBookingsReport } from '@/services/staffReportService';
import { RangeFilter, formatRangeLabel } from '@/features/financial-reports/RangeFilter';
import { useReportRange, toDateParam } from '@/features/financial-reports/useReportRange';
import { downloadStaffBookingsCsv, downloadStaffBookingsPdf, statusGroup, statusWords } from './staffBookingsExport';

// The assistant loads only when it is opened, so the report's first paint is unchanged.
const AssistantPanel = lazy(() => import('@/features/financial-reports/AssistantPanel'));

const QUICK_QUESTIONS = [
  "Show me today's bookings",
  'What were the bookings tomorrow?',
  'How many bookings this week?',
  'What are the most booked services this month?',
  'Which technician has the most vehicles this week?',
  "Create a PDF of this week's bookings"
];

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const dayText = (day) => new Date(`${day}T12:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
const fileLabelOf = (text) => text.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '');

const STATUS_FILTERS = [
  { value: 'all', label: 'All statuses' },
  { value: 'upcoming', label: 'Scheduled or confirmed' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Finished (completed or released)' },
  { value: 'cancelled', label: 'Cancelled or no-show' }
];
const statusVariant = (status) => {
  const group = statusGroup(status);
  if (group === 'cancelled') return 'outline';
  if (group === 'completed') return 'secondary';
  return 'default';
};

function BarList({ rows, valueKey, labelKey, formatLabel = (value) => value, empty }) {
  const max = Math.max(1, ...rows.map((row) => Number(row[valueKey]) || 0));
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="grid gap-2">
      {rows.map((row) => (
        <li key={String(row[labelKey])} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium">{formatLabel(row[labelKey])}</span>
            <span className="tabular-nums text-muted-foreground">{row[valueKey]}</span>
          </div>
          <div className="h-1.5 w-full bg-muted" style={{ borderRadius: 'var(--admin-radius-sm)' }}>
            <div className="h-1.5 bg-primary" style={{ width: `${Math.max(4, ((Number(row[valueKey]) || 0) / max) * 100)}%`, borderRadius: 'var(--admin-radius-sm)' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Staff reports: every booking report a technician could ask for, for the whole shop, but only about bookings.
 * It never shows money, payments, prices, or customer contact details: the database function behind it
 * (staff_bookings_report) leaves them out, and an administrator must turn reports on for the account.
 * The "Ask the bookings assistant" panel is the same helper the administrator has, limited to bookings.
 */
export default function StaffBookingsReport() {
  const { preset, range, setPreset, setCustomRange } = useReportRange('bookings');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');

  const rangeLabel = useMemo(() => formatRangeLabel(range), [range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await fetchStaffBookingsReport(range));
    } catch (error) {
      console.error('Staff bookings report failed:', error);
      toast.error(/not enabled/i.test(error?.message || '') ? 'Reports are not turned on for your account.' : 'Could not load the bookings report.');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const totals = report?.totals || {};
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (report?.bookings || []).filter((b) => {
      if (statusFilter !== 'all' && statusGroup(b.status) !== statusFilter) return false;
      if (!term) return true;
      const haystack = [b.reference, b.customer, ...(b.vehicles || []).flatMap((v) => [v.brand, v.model, v.plate, v.technician, ...(v.services || [])])].join(' ').toLowerCase();
      return haystack.includes(term);
    });
  }, [report, statusFilter, search]);

  // The assistant (and the buttons) can ask for another day or period; the report itself is always the database's.
  const showRange = (from, to) => {
    const parse = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
    setCustomRange(parse(from), parse(to));
  };
  const dataFor = async (from, to) => {
    if (!from) return { data: report, label: rangeLabel };
    const parse = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
    const start = parse(from);
    const end = parse(to || from);
    end.setDate(end.getDate() + 1);
    return { data: await fetchStaffBookingsReport({ from: start, to: end }), label: formatRangeLabel({ from: start, to: end }) };
  };
  const downloadPdf = async (from, to) => {
    setBusy('pdf');
    try {
      const { data, label } = await dataFor(from, to);
      await downloadStaffBookingsPdf({ report: data, rangeLabel: label, fileLabel: fileLabelOf(label) });
    } catch (error) {
      console.error('Staff bookings PDF failed:', error);
      toast.error('Could not create the PDF.');
    } finally {
      setBusy('');
    }
  };
  const downloadCsv = () => downloadStaffBookingsCsv({ report, fileLabel: fileLabelOf(rangeLabel) });

  const kpis = [
    ['Bookings', totals.bookings], ['Vehicles', totals.vehicles], ['Scheduled or confirmed', totals.upcoming],
    ['In progress', totals.in_progress], ['Finished', totals.completed], ['Cancelled or no-show', totals.cancelled]
  ];

  return (
    <div className="ui-root grid gap-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <RangeFilter preset={preset} range={range} onPresetChange={setPreset} onCustomRange={setCustomRange} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setAssistantOpen(true)}><Sparkles /> Ask the bookings assistant</Button>
          <Button variant="outline" onClick={() => downloadPdf()} disabled={loading || busy === 'pdf' || !(report?.bookings || []).length}><FileDown /> {busy === 'pdf' ? 'Creating PDF…' : 'Download PDF'}</Button>
          <Button variant="outline" onClick={downloadCsv} disabled={loading || !(report?.bookings || []).length}><FileSpreadsheet /> Download CSV</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {kpis.map(([name, value]) => (
          <Card key={name} className="gap-1 py-4">
            <CardContent className="px-4">
              <p className="text-xs font-semibold uppercase text-muted-foreground">{name}</p>
              {loading ? <Skeleton className="mt-1 h-7 w-12" /> : <p className="text-2xl font-bold tabular-nums">{value ?? 0}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="gap-3 py-5">
          <CardHeader className="px-5"><CardTitle className="text-base">Bookings per day</CardTitle><CardDescription>Cancelled bookings are not counted</CardDescription></CardHeader>
          <CardContent className="px-5">
            {loading ? <Skeleton className="h-24 w-full" /> : <BarList rows={(report?.by_day || []).slice(-14)} valueKey="bookings" labelKey="day" formatLabel={dayText} empty="No bookings in this range." />}
          </CardContent>
        </Card>
        <Card className="gap-3 py-5">
          <CardHeader className="px-5"><CardTitle className="text-base">Most booked services</CardTitle><CardDescription>How often each service was booked</CardDescription></CardHeader>
          <CardContent className="px-5">
            {loading ? <Skeleton className="h-24 w-full" /> : <BarList rows={(report?.by_service || []).slice(0, 8)} valueKey="count" labelKey="name" empty="No services booked in this range." />}
          </CardContent>
        </Card>
        <Card className="gap-3 py-5">
          <CardHeader className="px-5"><CardTitle className="text-base">Technician workload</CardTitle><CardDescription>Vehicles assigned to each technician</CardDescription></CardHeader>
          <CardContent className="px-5">
            {loading ? <Skeleton className="h-24 w-full" /> : <BarList rows={(report?.by_technician || []).slice(0, 8)} valueKey="vehicles" labelKey="name" empty="No vehicles assigned in this range." />}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>All bookings</CardTitle>
            <CardDescription>{rangeLabel} · bookings that start in this range. Money and contact details are not shown.</CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customer, plate, service…" aria-label="Search bookings" className="sm:w-64" data-no-auto-capitalize="true" />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[210px]" aria-label="Filter by status"><SelectValue /></SelectTrigger>
              <SelectContent>{STATUS_FILTERS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table className="min-w-[680px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Start</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Vehicles, services and technician</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={4}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
                ))}
                {!loading && rows.length === 0 && (
                  <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">{(report?.bookings || []).length ? 'No bookings match your search.' : 'No bookings start in this range.'}</TableCell></TableRow>
                )}
                {!loading && rows.map((b) => (
                  <TableRow key={b.reference + b.start}>
                    <TableCell className="whitespace-nowrap">{when(b.start)}<div className="font-mono text-xs text-muted-foreground">#{b.reference}</div></TableCell>
                    <TableCell>{b.customer}{b.walk_in && <div className="text-xs text-muted-foreground">Walk-in</div>}</TableCell>
                    <TableCell>
                      {(b.vehicles || []).length === 0 && <span className="text-muted-foreground">—</span>}
                      {(b.vehicles || []).map((v, i) => (
                        <div key={i} className="mb-1 last:mb-0">
                          <span className="font-semibold">{[v.brand, v.model].filter(Boolean).join(' ') || 'Vehicle'}</span>{v.plate ? ` (${v.plate})` : ''}
                          <div className="text-xs text-muted-foreground">{(v.services || []).join(', ')}{v.technician ? ` · ${v.technician}` : ''}</div>
                        </div>
                      ))}
                    </TableCell>
                    <TableCell><Badge variant={statusVariant(b.status)}>{statusWords(b.status)}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!loading && (totals.bookings || 0) > (report?.bookings || []).length && (
            <p className="mt-3 text-xs text-muted-foreground">Showing the first {(report?.bookings || []).length} of {totals.bookings} bookings. Choose a shorter period to see the rest.</p>
          )}
        </CardContent>
      </Card>

      {assistantOpen && (
        <Suspense fallback={null}>
          <AssistantPanel
            open={assistantOpen}
            onOpenChange={setAssistantOpen}
            range={{ from: toDateParam(range.from), to: toDateParam(new Date(range.to.getTime() - 1)) }}
            endpoint="/api/staff/analytics-assistant"
            quickQuestions={QUICK_QUESTIONS}
            title="Ask the bookings assistant"
            description="Ask about bookings, services, vehicles, and technician workload for any day. It can open a report or create a PDF. It does not have payments, prices, or customer contact details, and it cannot change any data."
            busyText="Reading the bookings…"
            onSetRange={showRange}
            onShowBookings={showRange}
            onBookingsPdf={(from, to) => downloadPdf(from, to)}
            onExport={downloadCsv}
          />
        </Suspense>
      )}
    </div>
  );
}
