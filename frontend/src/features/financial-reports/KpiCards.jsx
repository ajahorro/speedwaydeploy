import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatPeso } from '@/features/finance/money';

/**
 * Every figure here is read straight from sales_report(); nothing is computed
 * in the browser, so these cards always match booking balances and receipts.
 */
const KPIS = [
  { key: 'net_revenue', label: 'Net revenue', hint: 'Net received minus refunds', emphasis: true, tone: 'text-emerald-500' },
  { key: 'net_received', label: 'Net received', hint: 'Money that reached the shop' },
  { key: 'refunds', label: 'Refunds', hint: 'Posted refund transactions', tone: 'text-chart-2' },
  { key: 'pending_verification', label: 'Pending verification', hint: 'Receipts awaiting an admin', tone: 'text-warning' },
  { key: 'outstanding_balance', label: 'Outstanding balance', hint: 'Owed on active bookings (today)', tone: 'text-destructive' },
  { key: 'deferred_receivables', label: 'Deferred receivables', hint: 'Marked "to be received" by an admin; not money received (today)' },
  { key: 'customer_credit_liability', label: 'Customer credit', hint: 'Credit held for customers (today)' },
  { key: 'average_ticket', label: 'Average per booking', hint: 'Net received ÷ paying bookings' }
];

export function KpiCards({ report, loading, compact = false }) {
  const items = compact ? KPIS.filter((kpi) => ['net_revenue', 'net_received', 'refunds', 'pending_verification'].includes(kpi.key)) : KPIS;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((kpi) => (
        <Card key={kpi.key} className={cn('gap-2 py-4', kpi.emphasis && 'border-primary/40')}>
          <CardHeader className="px-4">
            <CardDescription className="text-xs font-semibold uppercase tracking-wide">{kpi.label}</CardDescription>
            {loading || !report ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <CardTitle className={cn('text-2xl font-bold tabular-nums', kpi.tone)}>
                {formatPeso(report[kpi.key])}
              </CardTitle>
            )}
          </CardHeader>
          <CardContent className="px-4 text-xs text-muted-foreground">
            {kpi.key === 'net_received' && report
              ? `${report.transaction_count} transaction${report.transaction_count === 1 ? '' : 's'} · ${report.booking_count} booking${report.booking_count === 1 ? '' : 's'}`
              : kpi.hint}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
