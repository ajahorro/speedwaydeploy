import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPeso, formatPesoCompact } from '@/features/finance/money';
import { RANGE_PRESETS } from './useReportRange';

const chartConfig = {
  net_received: { label: 'Net received', color: 'var(--chart-1)' },
  refunds: { label: 'Refunds', color: 'var(--chart-2)' },
  pending_verification: { label: 'Pending verification', color: 'var(--chart-4)' }
};

const formatDay = (value) => {
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
};

/**
 * Interactive area chart (shadcn `chart-area-interactive` block), adapted:
 *  - data is the sales_report_daily() series, so it always matches the KPIs
 *  - the range picker drives the page-wide range instead of local state
 */
export function RevenueAreaChart({ data, loading, preset, onPresetChange, rangeLabel }) {
  const presets = RANGE_PRESETS.filter((option) => option.value !== 'custom' || preset === 'custom');

  return (
    <Card className="gap-0 pt-0">
      <CardHeader className="flex flex-col items-stretch gap-2 border-b py-5 sm:flex-row sm:items-center">
        <div className="grid flex-1 gap-1">
          <CardTitle>Revenue trend</CardTitle>
          <CardDescription>Net money received and refunds per day · {rangeLabel}</CardDescription>
        </div>
        <Select value={preset} onValueChange={onPresetChange}>
          <SelectTrigger className="w-full sm:ml-auto sm:w-[170px]" aria-label="Select a date range">
            <SelectValue placeholder="Last 30 days" />
          </SelectTrigger>
          <SelectContent>
            {presets.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {loading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[260px] w-full">
            <AreaChart data={data} margin={{ left: 4, right: 8 }}>
              <defs>
                <linearGradient id="fillNetReceived" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-net_received)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-net_received)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillRefunds" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-refunds)" stopOpacity={0.7} />
                  <stop offset="95%" stopColor="var(--color-refunds)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={formatDay}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={formatPesoCompact}
              />
              <ChartTooltip
                cursor={false}
                content={(
                  <ChartTooltipContent
                    labelFormatter={formatDay}
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">{chartConfig[name]?.label || name}</span>
                        <span className="font-mono font-medium tabular-nums text-foreground">{formatPeso(value)}</span>
                      </div>
                    )}
                    indicator="dot"
                  />
                )}
              />
              <Area
                dataKey="refunds"
                type="monotone"
                fill="url(#fillRefunds)"
                stroke="var(--color-refunds)"
              />
              <Area
                dataKey="net_received"
                type="monotone"
                fill="url(#fillNetReceived)"
                stroke="var(--color-net_received)"
              />
              <Area
                dataKey="pending_verification"
                type="monotone"
                fill="transparent"
                stroke="var(--color-pending_verification)"
                strokeDasharray="4 4"
              />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
