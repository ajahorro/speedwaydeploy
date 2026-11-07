import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, ExternalLink, FileImage, FileText, ImageOff, Search } from 'lucide-react';
import toast from '@/lib/toast';
import { supabase } from '@/lib/supabase';
import { subscribeTable } from '@/lib/realtimeHub';
import PageHeader from '@/components/PageHeader';
import PaymentReceipt from '@/components/PaymentReceipt';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { usePaged } from '@/components/common/ListPager';
import { matchesSearchText } from '@/utils/searchMatch';
import { formatPeso } from '@/features/finance/money';
import RefundProofButton from '@/features/finance/RefundProofButton';
import { useRefundProofs } from '@/hooks/useRefundProofs';
import { ADMIN_TOURS } from '@/features/tours/adminTours';
import { formatReceiptNo, getReceiptNumber, isCashMethod, methodLabel } from '../../../../shared/receiptModel.ts';

/**
 * Finance › Receipts & Proofs.
 *
 * One place to look up any payment or refund after the fact: its receipt number, the customer's proof of payment
 * (or the shop's proof of refund), and the acknowledgement receipt itself. Read-only: verifying and rejecting stay on
 * Payment Verification, sending refunds stays in the Refund Hub.
 */

const VIEWS = [
  { key: 'ALL', label: 'All' },
  { key: 'VERIFIED', label: 'Verified' },
  { key: 'WAITING', label: 'Waiting for check' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'REFUNDS', label: 'Refunds' },
];

const STATUS = {
  PAID: { label: 'Verified', tone: 'success' },
  FOR_VERIFICATION: { label: 'Waiting for check', tone: 'warning' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  REFUND_PENDING: { label: 'Refund pending', tone: 'warning' },
  REFUNDED: { label: 'Refunded', tone: 'muted' },
};
// Status is plain coloured text (no pill or outline): the colour alone carries the state, the word says it.
const TONES = {
  success: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
};

const isRefundRow = (p) => Number(p.amount) < 0
  && (String(p.method || '').toUpperCase() === 'SYSTEM_REFUND' || String(p.status || '').toUpperCase() === 'REFUNDED');
const hasReceipt = (p) => isRefundRow(p)
  || (Number(p.amount) > 0 && ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(String(p.status || '').toUpperCase()));
const statusOf = (p) => (isRefundRow(p) ? { label: 'Refund sent', tone: 'muted' } : STATUS[String(p.status || '').toUpperCase()] || { label: String(p.status || '—'), tone: 'muted' });
const customerOf = (b) => b?.customer_name || b?.customer?.full_name
  || [b?.guest_first_name, b?.guest_last_name].filter(Boolean).join(' ') || b?.guest_name || 'Walk-in';
const bookingNoOf = (p) => String(p.booking_id || '').slice(0, 8).toUpperCase();
const referenceOf = (p) => p.reference_number || p.detected_ref || '';
const dateOf = (p) => p.verified_at || p.created_at;
const fmtDate = (value) => (value
  ? new Date(value).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—');
const fmtDay = (value) => (value ? new Date(value).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const fmtTime = (value) => (value ? new Date(value).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }) : '');
const proofUrl = (path) => {
  if (!path) return null;
  if (String(path).startsWith('http')) return path;
  return supabase.storage.from('payment-receipts').getPublicUrl(path).data.publicUrl;
};
const dayStart = (iso) => (iso ? new Date(`${iso}T00:00:00`) : null);
const dayEnd = (iso) => (iso ? new Date(`${iso}T23:59:59.999`) : null);

function StatusBadge({ payment }) {
  const s = statusOf(payment);
  return <span className={`whitespace-nowrap text-sm font-semibold ${TONES[s.tone]}`}>{s.label}</span>;
}

/** The proof column: a small preview of the customer's upload, the shop's proof of refund, or a plain note. */
function ProofCell({ payment, refundProof }) {
  const { openImage } = useImagePreview();
  const [broken, setBroken] = useState(false);
  if (isRefundRow(payment)) {
    return refundProof?.storage_path
      ? <RefundProofButton proof={refundProof} />
      : <span className="text-xs text-muted-foreground">No proof saved</span>;
  }
  const url = proofUrl(payment.receipt_url);
  if (url) {
    return (
      <button
        type="button"
        onClick={() => openImage(url, { alt: 'Proof of payment', caption: `Proof of payment · ${referenceOf(payment) || 'no reference'}` })}
        className="group flex items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Open proof of payment"
      >
        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-sm border bg-muted">
          {broken
            ? <FileImage className="size-4 text-muted-foreground" aria-hidden="true" />
            : <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} className="!h-full !w-full object-cover" />}
        </span>
        <span className="text-xs font-semibold underline-offset-2 group-hover:underline">View</span>
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <ImageOff className="size-3.5" aria-hidden="true" />
      {isCashMethod(payment.method) ? 'Paid in cash' : 'No upload'}
    </span>
  );
}

export default function ReceiptsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('ALL');
  const [method, setMethod] = useState('ALL');
  const [proof, setProof] = useState('ANY');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [receipt, setReceipt] = useState(null); // { booking, payment }
  const [opening, setOpening] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('payments')
        .select('*, booking:bookings!payments_booking_id_fkey(id, customer_name, guest_name, guest_first_name, guest_last_name, start_datetime, customer:profiles!bookings_customer_id_fkey(full_name, email))')
        .neq('method', 'RECEIVABLE')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setRows(data || []);
    } catch (err) {
      console.error('Receipts & Proofs load failed', err);
      toast.error('Could not load the payment records. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => subscribeTable({ table: 'payments' }, () => setRefreshKey((k) => k + 1)), []);

  const refundBookingIds = useMemo(() => rows.filter(isRefundRow).map((p) => p.booking_id), [rows]);
  const { proofFor } = useRefundProofs(refundBookingIds, refreshKey);

  const methods = useMemo(() => {
    const set = new Set(rows.filter((p) => !isRefundRow(p)).map((p) => String(p.method || '').toUpperCase()).filter(Boolean));
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const start = dayStart(from);
    const end = dayEnd(to);
    return rows.filter((p) => {
      const status = String(p.status || '').toUpperCase();
      const refund = isRefundRow(p);
      if (view === 'VERIFIED' && (refund || status !== 'PAID')) return false;
      if (view === 'WAITING' && status !== 'FOR_VERIFICATION') return false;
      if (view === 'REJECTED' && status !== 'REJECTED') return false;
      if (view === 'REFUNDS' && !(refund || status === 'REFUND_PENDING' || status === 'REFUNDED')) return false;
      if (method !== 'ALL' && String(p.method || '').toUpperCase() !== method) return false;
      if (proof !== 'ANY') {
        const has = refund ? Boolean(proofFor(p)?.storage_path) : Boolean(p.receipt_url);
        if (proof === 'WITH' && !has) return false;
        if (proof === 'WITHOUT' && has) return false;
      }
      const when = new Date(dateOf(p));
      if (start && when < start) return false;
      if (end && when > end) return false;
      return matchesSearchText(
        query,
        formatReceiptNo(p.receipt_no), p.receipt_no, referenceOf(p), customerOf(p.booking), p.booking?.customer?.email,
        bookingNoOf(p), p.booking_id, methodLabel(p.method), Math.abs(Number(p.amount || 0)).toFixed(2), statusOf(p).label,
      );
    });
  }, [rows, view, method, proof, from, to, query, proofFor]);

  const totals = useMemo(() => filtered.reduce((acc, p) => {
    if (isRefundRow(p)) acc.refunded += Math.abs(Number(p.amount || 0));
    else if (String(p.status || '').toUpperCase() === 'PAID') acc.received += Number(p.amount || 0);
    if (!isRefundRow(p) && !isCashMethod(p.method) && !p.receipt_url && Number(p.amount) > 0) acc.missingProof += 1;
    return acc;
  }, { received: 0, refunded: 0, missingProof: 0 }), [filtered]);

  const { rows: pageRows, pager } = usePaged(filtered, { resetKey: [view, method, proof, from, to, query], label: 'records' });

  const openReceipt = async (payment) => {
    setOpening(payment.id);
    try {
      const { data, error } = await supabase
        .from('bookings')
        .select('*, payments:payments!payments_booking_id_fkey(*), vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services(*))')
        .eq('id', payment.booking_id)
        .single();
      if (error) throw error;
      setReceipt({ booking: data, payment });
    } catch (err) {
      console.error('Receipt load failed', err);
      toast.error('The receipt could not be opened. Please try again.');
    } finally {
      setOpening(null);
    }
  };

  const exportCsv = () => {
    const header = ['Receipt no.', 'Date', 'Customer', 'Booking no.', 'Method', 'Reference no.', 'Amount', 'Status', 'Proof'];
    const lines = filtered.map((p) => [
      formatReceiptNo(p.receipt_no) || '',
      fmtDate(dateOf(p)),
      customerOf(p.booking),
      bookingNoOf(p),
      isRefundRow(p) ? 'Refund' : methodLabel(p.method),
      referenceOf(p),
      Number(p.amount || 0).toFixed(2),
      statusOf(p).label,
      isRefundRow(p) ? (proofFor(p)?.storage_path ? 'Proof of refund saved' : 'None') : (p.receipt_url ? 'Uploaded' : (isCashMethod(p.method) ? 'Cash' : 'None')),
    ]);
    const csv = [header, ...lines].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `receipts-and-proofs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const clearFilters = () => { setView('ALL'); setMethod('ALL'); setProof('ANY'); setFrom(''); setTo(''); setQuery(''); };
  const filtersOn = view !== 'ALL' || method !== 'ALL' || proof !== 'ANY' || from || to || query;

  const actions = (p, compact = false) => (
    <div className="flex flex-wrap justify-end gap-2 @6xl:flex-nowrap">
      {hasReceipt(p) && (
        <Button type="button" size="sm" variant="outline" disabled={opening === p.id} onClick={() => openReceipt(p)}>
          <FileText aria-hidden="true" /> {opening === p.id ? 'Opening…' : 'Receipt'}
        </Button>
      )}
      <Button type="button" size={compact ? 'icon-sm' : 'sm'} variant="ghost" onClick={() => navigate(`/admin/bookings/${p.booking_id}`)} title="Open the booking" aria-label={compact ? 'Open the booking' : undefined}>
        <ExternalLink aria-hidden="true" />{compact ? null : ' Booking'}
      </Button>
    </div>
  );

  return (
    <div className="ui-root @container flex flex-col gap-6 pb-16">
      {receipt && (
        <PaymentReceipt
          booking={receipt.booking}
          vehicles={receipt.booking.vehicles || []}
          selectedPayment={receipt.payment}
          onClose={() => setReceipt(null)}
        />
      )}

      <PageHeader
        title="Receipts & Proofs"
        subtitle="Every payment and refund with its receipt number, proof, and acknowledgement receipt."
        tour={ADMIN_TOURS.receipts}
      />

      {/* totals for what is shown */}
      <div className="grid grid-cols-1 gap-3 @md:grid-cols-3" data-tour="rcp-totals">
        <Card className="gap-1 rounded-md p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Verified payments</p>
          <p className="text-xl font-black tabular-nums">{formatPeso(totals.received)}</p>
        </Card>
        <Card className="gap-1 rounded-md p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Refunds sent</p>
          <p className="text-xl font-black tabular-nums">{formatPeso(totals.refunded)}</p>
        </Card>
        <Card className="gap-1 rounded-md p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Online payments with no upload</p>
          <p className="text-xl font-black tabular-nums">{totals.missingProof}</p>
        </Card>
      </div>

      {/* filters */}
      <Card className="gap-4 rounded-md p-4" data-tour="rcp-filters">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {VIEWS.map((v) => (
            <Button key={v.key} type="button" size="sm" variant={view === v.key ? 'default' : 'outline'} aria-pressed={view === v.key} onClick={() => setView(v.key)}>
              {v.label}
            </Button>
          ))}
        </div>
        {/* one row only when the page itself is wide; otherwise search on its own line and the rest wrap */}
        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @2xl:grid-cols-4 @5xl:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
          <div className="col-span-full grid min-w-0 gap-1.5 @5xl:col-span-1" data-tour="rcp-search">
            <Label htmlFor="rcp-q">Search</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input id="rcp-q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Receipt no., reference, customer, booking or amount" className="pl-8" />
            </div>
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="w-full min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All methods</SelectItem>
                {methods.map((m) => <SelectItem key={m} value={m}>{methodLabel(m)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label>Proof</Label>
            <Select value={proof} onValueChange={setProof}>
              <SelectTrigger className="w-full min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ANY">With or without</SelectItem>
                <SelectItem value="WITH">With proof</SelectItem>
                <SelectItem value="WITHOUT">Without proof</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="rcp-from">From</Label>
            <Input id="rcp-from" type="date" className="w-full min-w-0 dark:[color-scheme:dark]" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="rcp-to">To</Label>
            <Input id="rcp-to" type="date" className="w-full min-w-0 dark:[color-scheme:dark]" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{filtered.length} {filtered.length === 1 ? 'record' : 'records'}</p>
          <div className="flex flex-wrap gap-2">
            {filtersOn && <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>Clear filters</Button>}
            <Button type="button" size="sm" variant="outline" onClick={exportCsv} disabled={!filtered.length}>
              <Download aria-hidden="true" /> Export CSV
            </Button>
          </div>
        </div>
      </Card>

      {/* list */}
      <div data-tour="rcp-list">
        {loading ? (
          <div className="grid gap-2" aria-busy="true"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
        ) : filtered.length === 0 ? (
          <Card className="items-center gap-2 rounded-md p-10 text-center">
            <p className="font-semibold">No records match these filters.</p>
            {filtersOn && <Button type="button" size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button>}
          </Card>
        ) : (
          <>
            {/* computer: table */}
            <Card className="hidden gap-0 overflow-hidden rounded-md p-0 @6xl:flex">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="px-4">Receipt no.</TableHead>
                    <TableHead className="px-4">Date</TableHead>
                    <TableHead className="px-4">Customer / booking</TableHead>
                    <TableHead className="px-4">Method &amp; reference</TableHead>
                    <TableHead className="px-4 text-right">Amount</TableHead>
                    <TableHead className="px-4">Status</TableHead>
                    <TableHead className="px-4">Proof</TableHead>
                    <TableHead className="px-4 text-right"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="px-4 font-mono text-sm font-bold" translate="no">{hasReceipt(p) ? getReceiptNumber(p) : '—'}</TableCell>
                      <TableCell className="px-4 text-sm text-muted-foreground">
                        <span className="block whitespace-nowrap">{fmtDay(dateOf(p))}</span>
                        <span className="block whitespace-nowrap text-xs">{fmtTime(dateOf(p))}</span>
                      </TableCell>
                      <TableCell className="px-4">
                        <p className="text-sm font-semibold" translate="no">{customerOf(p.booking)}</p>
                        <p className="font-mono text-xs text-muted-foreground" translate="no">Booking {bookingNoOf(p)}</p>
                      </TableCell>
                      <TableCell className="px-4">
                        <p className="text-sm">{isRefundRow(p) ? 'Refund' : methodLabel(p.method)}</p>
                        <p className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground" translate="no" title={referenceOf(p)}>{referenceOf(p) || '—'}</p>
                      </TableCell>
                      <TableCell className={`px-4 text-right font-bold tabular-nums ${Number(p.amount) < 0 ? 'text-destructive' : ''}`}>{formatPeso(p.amount)}</TableCell>
                      <TableCell className="px-4"><StatusBadge payment={p} /></TableCell>
                      <TableCell className="px-4"><ProofCell payment={p} refundProof={proofFor(p)} /></TableCell>
                      <TableCell className="px-4">{actions(p, true)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>

            {/* phone: cards */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3 @6xl:hidden">
              {pageRows.map((p) => (
                <Card key={p.id} className="gap-3 rounded-md p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-bold" translate="no">{hasReceipt(p) ? `Receipt ${getReceiptNumber(p)}` : 'No receipt yet'}</p>
                      <p className="truncate text-sm font-semibold" translate="no">{customerOf(p.booking)}</p>
                      <p className="text-xs text-muted-foreground">{fmtDate(dateOf(p))}</p>
                    </div>
                    <div className="text-right">
                      <p className={`font-bold tabular-nums ${Number(p.amount) < 0 ? 'text-destructive' : ''}`}>{formatPeso(p.amount)}</p>
                      <StatusBadge payment={p} />
                    </div>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Booking</dt><dd className="font-mono" translate="no">{bookingNoOf(p)}</dd>
                    <dt className="text-muted-foreground">Method</dt><dd>{isRefundRow(p) ? 'Refund' : methodLabel(p.method)}</dd>
                    <dt className="text-muted-foreground">Reference</dt><dd className="break-all font-mono" translate="no">{referenceOf(p) || '—'}</dd>
                  </dl>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                    <ProofCell payment={p} refundProof={proofFor(p)} />
                    {actions(p)}
                  </div>
                </Card>
              ))}
            </div>
            <div className="mt-3">{pager}</div>
          </>
        )}
      </div>
    </div>
  );
}
