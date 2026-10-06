import { useEffect, useState } from 'react';
import toast from '@/lib/toast';
import { FileDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchBookingsReport } from '@/services/ledgerService';
import { formatPeso } from '@/features/finance/money';
import { downloadBookingsPdf } from './bookingsPdf';

const statusVariant = (status) => {
  const value = String(status || '').toUpperCase();
  if (value === 'CANCELLED') return 'outline';
  if (['COMPLETED', 'RELEASED'].includes(value)) return 'secondary';
  return 'default';
};
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

/**
 * Reports › Bookings: every booking of the selected range with its vehicles, services and the money
 * behind it (all figures from the payment ledger through bookings_report()), plus a PDF of the same.
 */
export function BookingsTable({ range, rangeLabel, refreshKey, pdfRequest }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchBookingsReport(range)
      .then((data) => { if (alive) setReport(data); })
      .catch(() => { if (alive) toast.error('Could not load the bookings report.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [range, refreshKey]);

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      const data = report || await fetchBookingsReport(range);
      await downloadBookingsPdf({ report: data, rangeLabel, fileLabel: rangeLabel.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '') });
    } catch (error) {
      console.error('Bookings PDF failed:', error);
      toast.error('Could not create the PDF.');
    } finally {
      setPdfBusy(false);
    }
  };

  // The assistant can ask for the PDF ("create a PDF of today's bookings").
  useEffect(() => {
    if (pdfRequest) downloadPdf();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfRequest]);

  const totals = report?.totals || {};
  const rows = report?.bookings || [];

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Bookings</CardTitle>
          <CardDescription>{rangeLabel} · bookings that start in this range, with their money</CardDescription>
        </div>
        <Button variant="outline" onClick={downloadPdf} disabled={loading || pdfBusy || rows.length === 0} title={rows.length === 0 ? 'No bookings in this range' : undefined}>
          <FileDown /> {pdfBusy ? 'Creating PDF…' : 'Download PDF'}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            ['Bookings', loading ? null : `${totals.count ?? 0}`],
            ['Booking value', loading ? null : formatPeso(totals.total_value)],
            ['Received (net)', loading ? null : formatPeso(totals.paid)],
            ['Balance owed', loading ? null : formatPeso(totals.balance)],
            ['To be received', loading ? null : formatPeso(totals.deferred)]
          ].map(([name, value]) => (
            <div key={name} className="rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">{name}</p>
              {value === null ? <Skeleton className="mt-1 h-6 w-24" /> : <p className="text-lg font-bold tabular-nums">{value}</p>}
            </div>
          ))}
        </div>

        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Start</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Vehicles and services</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
              ))}
              {!loading && rows.length === 0 && (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No bookings start in this range.</TableCell></TableRow>
              )}
              {!loading && rows.map((b) => (
                <TableRow key={b.booking_id}>
                  <TableCell className="whitespace-nowrap">{when(b.start_datetime)}<div className="font-mono text-xs text-muted-foreground">#{b.reference}</div></TableCell>
                  <TableCell>{b.customer_name}{b.technician && <div className="text-xs text-muted-foreground">Tech: {b.technician}</div>}</TableCell>
                  <TableCell>
                    {(b.vehicles || []).length === 0 && <span className="text-muted-foreground">—</span>}
                    {(b.vehicles || []).map((v, i) => (
                      <div key={i} className="mb-1 last:mb-0">
                        <span className="font-semibold">{[v.brand, v.model].filter(Boolean).join(' ') || 'Vehicle'}</span>{v.plate ? ` (${v.plate})` : ''}
                        <div className="text-xs text-muted-foreground">{(v.services || []).map((s) => s.name).join(', ')}</div>
                      </div>
                    ))}
                  </TableCell>
                  <TableCell><Badge variant={statusVariant(b.status)}>{String(b.status || '').replace(/_/g, ' ')}</Badge><div className="mt-1 text-xs text-muted-foreground">{String(b.paid_status || '').replace(/_/g, ' ')}</div></TableCell>
                  <TableCell className="text-right tabular-nums">{formatPeso(b.total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPeso(b.paid)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatPeso(b.balance)}
                    {Number(b.deferred) > 0 && <div className="text-xs font-normal text-muted-foreground">to be received {formatPeso(b.deferred)}</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
