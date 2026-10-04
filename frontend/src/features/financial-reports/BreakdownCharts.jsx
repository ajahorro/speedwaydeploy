import { Bar, BarChart, Cell, Label, Pie, PieChart, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { formatMethod, formatPeso, formatPesoCompact } from '@/features/finance/money';

const SLICE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

function EmptyState({ children }) {
  return <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">{children}</div>;
}

/** Net received by payment method (from sales_report().by_method). */
export function MethodBreakdownChart({ rows = [], total = 0, loading }) {
  const data = rows.map((row, index) => ({
    method: formatMethod(row.method),
    value: Number(row.net_received || 0),
    count: row.count,
    fill: SLICE_COLORS[index % SLICE_COLORS.length]
  }));
  const config = Object.fromEntries(data.map((row) => [row.method, { label: row.method, color: row.fill }]));

  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>Payment methods</CardTitle>
        <CardDescription>Net received by method</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-[220px] w-full" /> : !data.length ? <EmptyState>No payments in this range.</EmptyState> : (
          <div className="flex flex-col items-center gap-4 sm:flex-row">
            <ChartContainer config={config} className="aspect-square h-[200px]">
              <PieChart>
                <ChartTooltip
                  cursor={false}
                  content={<ChartTooltipContent hideLabel nameKey="method" formatter={(value, name) => `${name}: ${formatPeso(value)}`} />}
                />
                <Pie data={data} dataKey="value" nameKey="method" innerRadius={55} strokeWidth={2}>
                  {data.map((row) => <Cell key={row.method} fill={row.fill} />)}
                  <Label
                    content={({ viewBox }) => (viewBox && 'cx' in viewBox ? (
                      <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                        <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-base font-bold">{formatPesoCompact(total)}</tspan>
                        <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 18} className="fill-muted-foreground text-xs">total</tspan>
                      </text>
                    ) : null)}
                  />
                </Pie>
              </PieChart>
            </ChartContainer>
            <ul className="grid w-full gap-2 text-sm">
              {data.map((row) => (
                <li key={row.method} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-sm" style={{ background: row.fill }} />
                    {row.method}
                    <span className="text-xs text-muted-foreground">({row.count})</span>
                  </span>
                  <span className="font-mono tabular-nums">{formatPeso(row.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Most-booked services among paying bookings (from sales_report().top_services). */
export function TopServicesChart({ rows = [], loading }) {
  const data = rows.map((row) => ({ name: row.name, count: Number(row.count || 0) }));
  const config = { count: { label: 'Bookings', color: 'var(--chart-1)' } };

  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>Top services</CardTitle>
        <CardDescription>Most booked among paying bookings</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-[220px] w-full" /> : !data.length ? <EmptyState>No services in this range.</EmptyState> : (
          <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
              <XAxis type="number" hide allowDecimals={false} />
              <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={130} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={3} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
