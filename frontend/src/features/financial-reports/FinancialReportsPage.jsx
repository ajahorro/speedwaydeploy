import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { CalendarRange, Download, Printer, Sparkles } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { subscribeTable } from '@/lib/realtimeHub';
import { fetchSalesReport, fetchSalesReportDaily } from '@/services/ledgerService';
import { formatPeso } from '@/features/finance/money';
import { KpiCards } from './KpiCards';
import { RevenueAreaChart } from './RevenueAreaChart';
import { MethodBreakdownChart, TopServicesChart } from './BreakdownCharts';
import { TransactionsTable } from './TransactionsTable';
import { OutstandingTable } from './OutstandingTable';
import { downloadReportCsv } from './exportReport';
import { RANGE_PRESETS, useReportRange } from './useReportRange';

// The assistant is fetched only when an admin opens it, so the report's first paint is unchanged.
const AssistantPanel = lazy(() => import('./AssistantPanel'));

const toDayString = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const formatRangeLabel = ({ from, to }) => {
  const last = new Date(to.getTime() - 1);
  const options = { month: 'short', day: 'numeric', year: 'numeric' };
  return from.toDateString() === last.toDateString()
    ? from.toLocaleDateString('en-PH', options)
    : `${from.toLocaleDateString('en-PH', options)} – ${last.toLocaleDateString('en-PH', options)}`;
};

function RangeFilter({ preset, range, onPresetChange, onCustomRange }) {
  const [draft, setDraft] = useState({ from: range.from, to: new Date(range.to.getTime() - 1) });
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Select value={preset} onValueChange={onPresetChange}>
        <SelectTrigger className="w-full sm:w-[170px]" aria-label="Report period">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RANGE_PRESETS.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="justify-start font-normal">
            <CalendarRange /> {formatRangeLabel(range)}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={draft}
            onSelect={(value) => setDraft(value || { from: undefined, to: undefined })}
            disabled={{ after: new Date() }}
          />
          <div className="flex justify-end gap-2 border-t p-3">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!draft?.from}
              onClick={() => { onCustomRange(draft.from, draft.to || draft.from); setOpen(false); }}
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Financial Reports (UI-1). Every number on this page comes from the database
 * ledger: KPI cards and breakdowns from sales_report(), the chart from
 * sales_report_daily(), and tables from payment_ledger_v / booking_ledger_v.
 */
export default function FinancialReportsPage({ defaultTab = 'overview' }) {
  const navigate = useNavigate();
  const { preset, range, tab, method, setPreset, setCustomRange, setTab, setMethod } = useReportRange(defaultTab);
  const [report, setReport] = useState(null);
  const [daily, setDaily] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);

  const rangeLabel = useMemo(() => formatRangeLabel(range), [range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [summary, series] = await Promise.all([fetchSalesReport(range), fetchSalesReportDaily(range)]);
      setReport(summary);
      setDaily(series);
    } catch (error) {
      console.error('Financial report load failed:', error);
      toast.error(/administrator/i.test(error?.message || '')
        ? 'Only administrators can view financial reports.'
        : 'Failed to load the financial report.');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // A verified, refunded or newly submitted payment updates the report live.
  useEffect(() => {
    let timer = null;
    const stopRealtime = subscribeTable({ table: 'payments' }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRefreshKey((value) => value + 1), 800);
    });
    return () => { clearTimeout(timer); stopRealtime(); };
  }, []);

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await downloadReportCsv({ range, method, report });
      toast.success(result.truncated
        ? `Exported the first ${result.transactions} transactions.`
        : `Exported ${result.transactions} transactions and ${result.refunds} refunds.`);
    } catch (error) {
      console.error('Report export failed:', error);
      toast.error('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div id="printable-report" className="ui-root financial-report flex flex-col gap-6 pb-8">
      <div className="print:hidden">
        <PageHeader
          showBack
          onBack={() => navigate(-1)}
          badge="FINANCIAL REPORTS"
          title="Financial Reports"
          subtitle="Revenue, refunds and balances from the shop's single payment ledger."
          onRefresh={() => setRefreshKey((value) => value + 1)}
        >
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={handleExport} disabled={exporting || loading}>
              <Download /> {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
            <Button variant="outline" onClick={() => setAssistantOpen(true)}>
              <Sparkles /> Ask AI
            </Button>
            <Button onClick={() => window.print()} disabled={loading}>
              <Printer /> Print
            </Button>
          </div>
        </PageHeader>
      </div>

      <div className="hidden print:block">
        <h1 className="text-2xl font-bold">Comar Garage — Financial Report</h1>
        <p className="text-sm">{rangeLabel} · generated {new Date().toLocaleString('en-PH')}</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <RangeFilter
          key={`${range.from.getTime()}-${range.to.getTime()}`}
          preset={preset}
          range={range}
          onPresetChange={setPreset}
          onCustomRange={setCustomRange}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-fit print:hidden">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="refunds">Refunds &amp; credits</TabsTrigger>
          <TabsTrigger value="outstanding">Outstanding</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-4">
          <KpiCards report={report} loading={loading} />
          <RevenueAreaChart
            data={daily}
            loading={loading}
            preset={preset}
            onPresetChange={setPreset}
            rangeLabel={rangeLabel}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <MethodBreakdownChart rows={report?.by_method || []} total={report?.net_received || 0} loading={loading} />
            <TopServicesChart rows={report?.top_services || []} loading={loading} />
          </div>
        </TabsContent>

        <TabsContent value="transactions" className="flex flex-col gap-4">
          <TransactionsTable
            range={range}
            kind="settled"
            title="Money received"
            description={`Verified payments recognized ${rangeLabel}`}
            method={method}
            onMethodChange={setMethod}
            refreshKey={refreshKey}
          />
          <TransactionsTable
            range={range}
            kind="pending"
            title="Awaiting verification"
            description="Submitted receipts not yet confirmed — not counted as revenue"
            method="ALL"
            refreshKey={refreshKey}
          />
        </TabsContent>

        <TabsContent value="refunds" className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Refunds in range</p>
              <p className="text-2xl font-bold tabular-nums text-chart-2">{formatPeso(report?.refunds)}</p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Overpayments held</p>
              <p className="text-2xl font-bold tabular-nums">{formatPeso(report?.overpayments)}</p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Customer credit</p>
              <p className="text-2xl font-bold tabular-nums">{formatPeso(report?.customer_credit_liability)}</p>
            </div>
          </div>
          <TransactionsTable
            range={range}
            kind="refund"
            title="Refund transactions"
            description={`Refunds posted ${rangeLabel}`}
            method="ALL"
            refreshKey={refreshKey}
          />
        </TabsContent>

        <TabsContent value="outstanding">
          <OutstandingTable refreshKey={refreshKey} />
        </TabsContent>
      </Tabs>

      {assistantOpen && (
        <Suspense fallback={null}>
          <AssistantPanel
            open={assistantOpen}
            onOpenChange={setAssistantOpen}
            range={{ from: toDayString(range.from), to: toDayString(new Date(range.to.getTime() - 1)) }}
            onSetRange={(from, to) => {
              const [fy, fm, fd] = from.split('-').map(Number);
              const [ty, tm, td] = to.split('-').map(Number);
              setCustomRange(new Date(fy, fm - 1, fd), new Date(ty, tm - 1, td));
              setTab('overview');
            }}
            onExport={handleExport}
          />
        </Suspense>
      )}

      <style>{`
        @media print {
          html, body, #root, main { background: white !important; height: auto !important; overflow: visible !important; }
          nav, aside, header, .admin-search-container { display: none !important; }
          /* The app-wide print rule (receipts) hides everything except #printable-receipt, which
             printed this page blank. Show the report, and release the fixed-height app shell so
             it can flow onto as many pages as it needs. */
          #printable-report, #printable-report * { visibility: visible !important; }
          #printable-report { position: absolute; left: 0; top: 0; width: 100%; }
          .admin-theme, .admin-main-wrapper { display: block !important; position: static !important; width: auto !important; height: auto !important; overflow: visible !important; margin-left: 0 !important; }
          .admin-theme main { height: auto !important; overflow: visible !important; padding: 0 !important; }
          .financial-report { color: black; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          @page { size: A4; margin: 12mm; }
        }
      `}</style>
    </div>
  );
}
