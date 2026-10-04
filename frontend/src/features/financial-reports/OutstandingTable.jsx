import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchOutstandingBookings } from '@/services/ledgerService';
import { formatPeso } from '@/features/finance/money';
import { PaymentStatusBadge } from '@/features/finance/PaymentStatusBadge';

/** Active bookings that still owe money, straight from booking_ledger_v. */
export function OutstandingTable({ refreshKey }) {
  const [state, setState] = useState({ rows: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetchOutstandingBookings()
      .then((rows) => { if (!cancelled) setState({ rows, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setState({ rows: [], loading: false, error }); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  return (
    <Card className="gap-0">
      <CardHeader className="border-b pb-4">
        <CardTitle>Outstanding balances</CardTitle>
        <CardDescription>Active bookings with money still owed, as of now</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Booking</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Appointment</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Owed</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.loading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <TableRow key={index}><TableCell colSpan={7} className="px-6"><Skeleton className="h-5 w-full" /></TableCell></TableRow>
                ))
              ) : state.error ? (
                <TableRow><TableCell colSpan={7} className="px-6 py-10 text-center text-destructive">Could not load balances: {state.error.message}</TableCell></TableRow>
              ) : !state.rows.length ? (
                <TableRow><TableCell colSpan={7} className="px-6 py-10 text-center text-muted-foreground">No outstanding balances.</TableCell></TableRow>
              ) : state.rows.map((row) => (
                <TableRow key={row.booking_id}>
                  <TableCell className="pl-6 font-mono text-xs">
                    <Link className="text-primary hover:underline" to={`/admin/bookings/${row.booking_id}`}>
                      #{String(row.booking_id).slice(0, 8).toUpperCase()}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[180px] truncate">{row.customer_name}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.start_datetime ? new Date(row.start_datetime).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatPeso(row.expected_amount)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatPeso(row.net_settled)}</TableCell>
                  <TableCell className="text-right font-mono font-semibold tabular-nums text-destructive">{formatPeso(row.outstanding_amount)}</TableCell>
                  <TableCell className="pr-6"><PaymentStatusBadge status={row.paid_status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
