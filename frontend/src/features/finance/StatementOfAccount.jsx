import { useRef } from 'react';
import { Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { resolveFrozenServicePrice } from '@/data/servicesCatalog';
import {
  buildStatementLines,
  resolveInvoiceAmounts,
  statementTotalsFromLedger,
} from '../../../../shared/receiptModel.ts';
import { formatMethod, formatPeso } from './money';
import { PaymentStatusBadge } from './PaymentStatusBadge';

const dateLabel = (value) => (value
  ? new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
  : '—');

function TotalRow({ label, value, strong = false, tone }) {
  return (
    <div className={`flex justify-between gap-6 py-1 text-sm ${strong ? 'font-bold' : 'text-neutral-600'}`}>
      <span>{label}</span>
      <span className={`font-mono tabular-nums ${tone || ''}`}>{value}</span>
    </div>
  );
}

/**
 * Statement of Account — the cumulative paid-to-date document for a booking.
 *
 * Services come from the booking's frozen price snapshots; payments and refunds
 * are payment_ledger_v rows; every total is the booking_ledger_v row. It uses
 * the same shared/receiptModel helpers as the emailed Statement PDF, so the
 * page and the email can never disagree.
 */
export function StatementOfAccount({ booking, vehicles = [], ledger, transactions = [] }) {
  const documentRef = useRef(null);
  const lines = buildStatementLines(transactions);
  const totals = statementTotalsFromLedger(ledger);
  const invoice = resolveInvoiceAmounts(booking || {});
  const pending = transactions.filter((row) => row.is_pending);
  const statementNo = `SOA-${String(booking?.id || '').slice(0, 8).toUpperCase()}`;
  const customerName = booking?.customer_name || booking?.customer?.full_name || 'Valued Customer';
  const customerEmail = booking?.customer_email || booking?.customer?.email || '';

  const serviceRows = vehicles.flatMap((vehicle) => (vehicle.services || []).map((service, index) => ({
    key: service.id || `${vehicle.id}-${index}`,
    description: `${[vehicle.brand, vehicle.model].filter(Boolean).join(' ')} — ${service.service_name || service.service_name_snapshot || 'Service'}`,
    price: resolveFrozenServicePrice(service)
  })));

  const downloadPdf = async () => {
    if (!documentRef.current) return;
    try {
      const html2pdf = (await import('html2pdf.js')).default;
      html2pdf().set({
        margin: 0.5,
        filename: `Comar-Garage-${statementNo}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
      }).from(documentRef.current).save();
    } catch {
      window.print();
    }
  };

  return (
    <div className="ui-root mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div className="flex items-center gap-2">
          <PaymentStatusBadge status={ledger?.paid_status} />
          {pending.length > 0 && (
            <span className="text-xs text-neutral-600">
              {pending.length} payment{pending.length === 1 ? '' : 's'} awaiting verification (not yet included)
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100 hover:text-neutral-900" onClick={downloadPdf}><Download /> Download PDF</Button>
          <Button onClick={() => window.print()}><Printer /> Print</Button>
        </div>
      </div>

      <div ref={documentRef} className="rounded-lg bg-white p-6 text-neutral-900 shadow-sm sm:p-8 print:shadow-none">
        <div className="flex flex-col justify-between gap-4 border-b-2 border-neutral-900 pb-5 sm:flex-row">
          <div>
            <div className="text-2xl font-black italic">COMAR GARAGE</div>
            <div className="text-xs uppercase tracking-wider text-neutral-500">Auto Detailing Studio</div>
            <div className="mt-3 text-xs text-neutral-500">123 Comar Garage Drive, Quezon City, Metro Manila</div>
          </div>
          <div className="sm:text-right">
            <div className="text-xs font-black text-[#E61E2A]">STATEMENT OF ACCOUNT</div>
            <div className="mt-2 text-sm"><strong>Statement No.</strong> {statementNo}</div>
            <div className="mt-1 text-xs text-neutral-500">Issued {dateLabel(new Date().toISOString())}</div>
          </div>
        </div>

        <div className="my-6 grid gap-6 sm:grid-cols-2">
          <div>
            <div className="text-[0.65rem] font-bold uppercase text-neutral-400">Billed to</div>
            <div className="mt-1 font-bold">{customerName}</div>
            <div className="text-sm text-neutral-500">{customerEmail}</div>
          </div>
          <div>
            <div className="text-[0.65rem] font-bold uppercase text-neutral-400">Work order</div>
            <div className="mt-1 font-bold">WO-{String(booking?.id || '').slice(0, 8).toUpperCase()}</div>
            <div className="text-sm text-neutral-500">Appointment {dateLabel(booking?.start_datetime)}</div>
          </div>
        </div>

        <h3 className="mb-2 text-[0.7rem] font-bold uppercase text-neutral-500">Services</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <tbody>
              {(serviceRows.length ? serviceRows : [{ key: 'booking', description: 'Booking services', price: invoice.subtotal }]).map((row) => (
                <tr key={row.key} className="border-b border-neutral-100">
                  <td className="py-2 pr-4">{row.description}</td>
                  <td className="py-2 text-right font-mono tabular-nums">{formatPeso(row.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ml-auto mt-2 w-full max-w-xs">
          {invoice.discount > 0 && (
            <TotalRow label={`Discount${booking?.promo_name_snapshot ? ` (${booking.promo_name_snapshot})` : ''}`} value={`−${formatPeso(invoice.discount)}`} />
          )}
          <TotalRow label="Booking total" value={formatPeso(totals.bookingTotal)} strong />
        </div>

        <h3 className="mb-2 mt-8 text-[0.7rem] font-bold uppercase text-neutral-500">Payments and refunds</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b-2 border-neutral-200 text-left text-[0.65rem] uppercase text-neutral-500">
                <th className="py-2 pr-3 font-semibold">Date</th>
                <th className="py-2 pr-3 font-semibold">Receipt</th>
                <th className="py-2 pr-3 font-semibold">Method</th>
                <th className="py-2 pr-3 text-right font-semibold">Paid</th>
                <th className="py-2 pr-3 text-right font-semibold">Fee</th>
                <th className="py-2 text-right font-semibold">Net received</th>
              </tr>
            </thead>
            <tbody>
              {!lines.length ? (
                <tr><td colSpan={6} className="py-6 text-center text-neutral-500">No verified payments yet.</td></tr>
              ) : lines.map((line) => (
                <tr key={`${line.receiptNumber}-${line.kind}`} className="border-b border-neutral-100">
                  <td className="py-2 pr-3 whitespace-nowrap">{dateLabel(line.date)}</td>
                  <td className="py-2 pr-3 font-mono text-[0.65rem] break-all">{line.kind === 'refund' ? 'Refund' : line.receiptNumber}</td>
                  <td className="py-2 pr-3">{line.kind === 'refund' ? 'Refund' : formatMethod(line.method)}</td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">{line.kind === 'refund' ? '—' : formatPeso(line.grossPaid)}</td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums text-neutral-500">{line.kind === 'refund' ? '—' : formatPeso(line.transferFee)}</td>
                  <td className={`py-2 text-right font-mono font-semibold tabular-nums ${line.kind === 'refund' ? 'text-[#b91c1c]' : ''}`}>{formatPeso(line.netReceived)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="ml-auto mt-4 w-full max-w-xs border-t-2 border-neutral-900 pt-3">
          <TotalRow label="Total received (net)" value={formatPeso(totals.netReceived)} />
          {totals.refunded > 0 && <TotalRow label="Less refunds" value={`−${formatPeso(totals.refunded)}`} />}
          <TotalRow label="Net paid" value={formatPeso(totals.netPaid)} strong />
          {totals.creditHeld > 0 && <TotalRow label="Credit held for you" value={formatPeso(totals.creditHeld)} />}
          <div className="mt-2 flex justify-between rounded bg-neutral-100 px-3 py-2 font-bold">
            <span>Balance due</span>
            <span className="font-mono tabular-nums text-[#E61E2A]">{formatPeso(totals.balanceDue)}</span>
          </div>
        </div>

        <p className="mt-8 text-xs text-neutral-500">
          This statement lists every verified payment and refund on this booking. Transfer fees charged by your bank or
          e-wallet are shown for reference and are not credited to the booking. Each payment also has its own official
          receipt (RCP number).
        </p>
      </div>
    </div>
  );
}
