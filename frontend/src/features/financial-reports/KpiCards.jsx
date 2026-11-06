import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatPeso } from '@/features/finance/money';

/**
 * Every figure here is read straight from sales_report(); nothing is computed in the browser.
 *
 * Sales (bookings scheduled in the period that were not cancelled or no-shows):
 *   gross sales - discounts & promos = net sales;  average sale = net sales / those bookings.
 * Money and balances: refunds and pending verification for the period; outstanding, deferred and customer
 * credit as of today.
 */
const KPIS = [
  { key: 'gross_sales', label: 'Gross sales', hint: 'Price of the services before any discount', group: 'sales' },
  { key: 'discounts', label: 'Discounts & promos', hint: 'Taken off by promos and promo codes', tone: 'text-chart-2', group: 'sales' },
  { key: 'net_sales', label: 'Net sales', hint: 'Gross sales minus discounts and promos', emphasis: true, tone: 'text-emerald-500', group: 'sales' },
  { key: 'average_sale', label: 'Average sale', hint: 'Net sales per booking', group: 'sales' },
  { key: 'refunds', label: 'Refunds', hint: 'Money returned to customers', tone: 'text-chart-2' },
  { key: 'pending_verification', label: 'Pending verification', hint: 'Receipts waiting for an admin to check', tone: 'text-warning' },
  { key: 'outstanding_balance', label: 'Outstanding balance', hint: 'Still owed on active bookings (today)', tone: 'text-destructive' },
  { key: 'deferred_receivables', label: 'Deferred receivables', hint: 'Marked "to be received" by an admin; not paid yet (today)' },
  { key: 'customer_credit_liability', label: 'Customer credit', hint: 'Credit held for customers (today)' }
];

export function KpiCards({ report, loading, compact = false, onClick, gridClassName = 'sm:grid-cols-2 xl:grid-cols-3' }) {
  const items = compact ? KPIS.filter((kpi) => ['gross_sales', 'net_sales', 'refunds', 'pending_verification'].includes(kpi.key)) : KPIS;
  return (
    <div className={cn('grid grid-cols-1 gap-3', gridClassName)}>
      {items.map((kpi) => (
        <Card
          key={kpi.key}
          className={cn('gap-2 py-4', kpi.emphasis && 'border-primary/40', onClick && 'cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
          role={onClick ? 'link' : undefined}
          tabIndex={onClick ? 0 : undefined}
          onClick={onClick ? () => onClick(kpi.key) : undefined}
          onKeyDown={onClick ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onClick(kpi.key);
            }
          } : undefined}
        >
          <CardHeader className="px-4">
            <CardDescription className="text-xs font-semibold uppercase tracking-wide">{kpi.label}</CardDescription>
            {loading || !report ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <CardTitle className={cn('text-2xl font-bold tabular-nums', kpi.tone)}>
                {report[kpi.key] === undefined || report[kpi.key] === null ? '—' : formatPeso(report[kpi.key])}
              </CardTitle>
            )}
          </CardHeader>
          <CardContent className="px-4 text-xs text-muted-foreground">
            <span className="block">{kpi.hint}</span>
            {kpi.key === 'net_sales' && report && Number.isFinite(Number(report.sales_count)) && (
              <span className="block">{Number(report.sales_count) === 1 ? '1 booking' : `${report.sales_count} bookings`}</span>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
