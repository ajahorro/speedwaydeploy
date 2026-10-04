import { fetchLedgerTransactions } from '@/services/ledgerService';
import { formatMethod } from '@/features/finance/money';
import { toDateParam } from './useReportRange';

const MAX_ROWS = 5000;
const BATCH = 1000;

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const fetchAll = async (range, kind, method) => {
  const rows = [];
  for (let page = 0; rows.length < MAX_ROWS; page += 1) {
    const result = await fetchLedgerTransactions({ ...range, kind, method, page, pageSize: BATCH });
    rows.push(...result.rows);
    if (result.rows.length < BATCH) break;
  }
  return rows;
};

/**
 * CSV built from the same sales_report() totals and payment_ledger_v rows the
 * screen shows, so an exported file always reconciles with the page.
 */
export async function downloadReportCsv({ range, method, report }) {
  const [settled, refunds] = await Promise.all([
    fetchAll(range, 'settled', method),
    fetchAll(range, 'refund', 'ALL')
  ]);

  const toLabel = new Date(range.to.getTime() - 1);
  const lines = [
    ['Comar Garage financial report'],
    ['From', toDateParam(range.from), 'To', toDateParam(toLabel)],
    [],
    ['Summary'],
    ['Net revenue', report?.net_revenue],
    ['Net received', report?.net_received],
    ['Gross collected', report?.gross_collected],
    ['Transfer fees', report?.transfer_fees],
    ['Refunds', report?.refunds],
    ['Pending verification', report?.pending_verification],
    ['Outstanding balance (today)', report?.outstanding_balance],
    ['Customer credit (today)', report?.customer_credit_liability],
    [],
    ['Transactions'],
    ['Recognized at', 'Receipt no.', 'Booking', 'Customer', 'Method', 'Status', 'Gross paid', 'Transfer fee', 'Net received', 'Reference'],
    ...settled.map((row) => [
      row.recognized_at, `RCP-${row.payment_id}`, row.booking_id, row.customer_name, formatMethod(row.method),
      row.status, row.gross_paid, row.transfer_fee, row.net_received, row.reference
    ]),
    [],
    ['Refunds'],
    ['Created at', 'Booking', 'Customer', 'Amount refunded'],
    ...refunds.map((row) => [row.created_at, row.booking_id, row.customer_name, Math.abs(row.amount)])
  ];

  const csv = lines.map((line) => line.map(csvCell).join(',')).join('\n');
  // Byte-order mark so Excel opens the file as UTF-8 (₱ and names render correctly).
  const blob = new Blob([String.fromCharCode(0xfeff), csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `financial-report_${toDateParam(range.from)}_${toDateParam(toLabel)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { transactions: settled.length, refunds: refunds.length, truncated: settled.length >= MAX_ROWS };
}
