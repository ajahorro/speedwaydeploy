import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchLedgerTransactions } from '@/services/ledgerService';
import { formatMethod, formatPeso } from '@/features/finance/money';
import { PaymentStatusBadge } from '@/features/finance/PaymentStatusBadge';

const PAGE_SIZE = 25;

const METHOD_OPTIONS = [
  { value: 'ALL', label: 'All methods' },
  { value: 'GCASH', label: 'GCash' },
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'MAYA', label: 'Maya' }
];

const formatDateTime = (value) => (value
  ? new Date(value).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—');

function DetailRow({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

/**
 * Server-paginated ledger transactions. Columns are payment_ledger_v fields;
 * gross/fee/net are computed once in SQL, never here.
 */
export function TransactionsTable({ range, kind = 'settled', title, description, method, onMethodChange, refreshKey }) {
  const [page, setPage] = useState(0);
  const [state, setState] = useState({ rows: [], total: 0, loading: true, error: null });
  const [selected, setSelected] = useState(null);

  useEffect(() => { setPage(0); }, [range.from, range.to, method, kind]);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetchLedgerTransactions({ ...range, kind, method, page, pageSize: PAGE_SIZE })
      .then((result) => { if (!cancelled) setState({ ...result, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setState({ rows: [], total: 0, loading: false, error }); });
    return () => { cancelled = true; };
  }, [range, kind, method, page, refreshKey]);

  const pageCount = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  const isRefund = kind === 'refund';

  return (
    <Card className="gap-0">
      <CardHeader className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center">
        <div className="grid flex-1 gap-1">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {onMethodChange && (
          <Select value={method} onValueChange={onMethodChange}>
            <SelectTrigger className="w-full sm:w-[160px]" aria-label="Filter by payment method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHOD_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Date</TableHead>
                <TableHead>Booking</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Method</TableHead>
                {!isRefund && <TableHead className="text-right">Gross</TableHead>}
                {!isRefund && <TableHead className="text-right">Fee</TableHead>}
                <TableHead className="text-right">{isRefund ? 'Refunded' : 'Net received'}</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.loading ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <TableRow key={index}>
                    <TableCell colSpan={8} className="px-6"><Skeleton className="h-5 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : state.error ? (
                <TableRow>
                  <TableCell colSpan={8} className="px-6 py-10 text-center text-destructive">
                    Could not load transactions: {state.error.message}
                  </TableCell>
                </TableRow>
              ) : !state.rows.length ? (
                <TableRow>
                  <TableCell colSpan={8} className="px-6 py-10 text-center text-muted-foreground">
                    No transactions in this range.
                  </TableCell>
                </TableRow>
              ) : state.rows.map((row) => (
                <TableRow key={row.payment_id} className="cursor-pointer" onClick={() => setSelected(row)}>
                  <TableCell className="pl-6 whitespace-nowrap">{formatDateTime(isRefund || kind !== 'settled' ? row.created_at : row.recognized_at)}</TableCell>
                  <TableCell className="font-mono text-xs">#{String(row.booking_id || '').slice(0, 8).toUpperCase()}</TableCell>
                  <TableCell className="max-w-[180px] truncate">{row.customer_name}</TableCell>
                  <TableCell>{formatMethod(row.method)}</TableCell>
                  {!isRefund && <TableCell className="text-right font-mono tabular-nums">{formatPeso(row.gross_paid)}</TableCell>}
                  {!isRefund && <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{formatPeso(row.transfer_fee)}</TableCell>}
                  <TableCell className="text-right font-mono font-semibold tabular-nums">
                    {formatPeso(isRefund ? Math.abs(row.amount) : row.net_received)}
                  </TableCell>
                  <TableCell className="pr-6"><PaymentStatusBadge status={row.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between gap-3 px-6 pt-4 text-sm text-muted-foreground">
          <span>{state.total} transaction{state.total === 1 ? '' : 's'}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0 || state.loading} onClick={() => setPage((value) => value - 1)}>
              <ChevronLeft /> Prev
            </Button>
            <span className="tabular-nums">{page + 1} / {pageCount}</span>
            <Button variant="outline" size="sm" disabled={page + 1 >= pageCount || state.loading} onClick={() => setPage((value) => value + 1)}>
              Next <ChevronRight />
            </Button>
          </div>
        </div>
      </CardContent>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent className="w-full sm:max-w-md">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>Transaction details</SheetTitle>
                <SheetDescription>Receipt no. RCP-{selected.payment_id}</SheetDescription>
              </SheetHeader>
              <div className="grid gap-1 px-4">
                <DetailRow label="Booking">#{String(selected.booking_id || '').slice(0, 8).toUpperCase()}</DetailRow>
                <DetailRow label="Customer">{selected.customer_name}</DetailRow>
                <DetailRow label="Method">{formatMethod(selected.method)}</DetailRow>
                <DetailRow label="Status"><PaymentStatusBadge status={selected.status} /></DetailRow>
                <DetailRow label="Reference">{selected.reference || '—'}</DetailRow>
                <DetailRow label="Submitted">{formatDateTime(selected.created_at)}</DetailRow>
                <DetailRow label="Verified">{formatDateTime(selected.verified_at)}</DetailRow>
                <Separator className="my-2" />
                <DetailRow label="Declared by customer">{formatPeso(selected.declared_amount ?? selected.amount)}</DetailRow>
                <DetailRow label="OCR detected">{selected.detected_amount ? formatPeso(selected.detected_amount) : '—'}</DetailRow>
                <DetailRow label="Admin verified">{selected.verified_amount ? formatPeso(selected.verified_amount) : '—'}</DetailRow>
                <Separator className="my-2" />
                <DetailRow label="Gross paid">{formatPeso(selected.gross_paid)}</DetailRow>
                <DetailRow label="Transfer fee">{formatPeso(selected.transfer_fee)}</DetailRow>
                <DetailRow label="Net received"><span className="text-primary">{formatPeso(selected.net_received)}</span></DetailRow>
              </div>
              <div className="px-4 pt-4">
                <Button asChild className="w-full">
                  <Link to={`/admin/bookings/${selected.booking_id}`}>
                    Open booking <ExternalLink />
                  </Link>
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </Card>
  );
}
