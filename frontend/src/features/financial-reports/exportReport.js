import { fetchBookingsReport, fetchLedgerTransactions, fetchOutstandingBookings } from '@/services/ledgerService';
import { formatMethod } from '@/features/finance/money';
import { toDateParam } from './useReportRange';

const MAX_ROWS = 5000;
const BATCH = 1000;

const formatDate = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return String(iso);
  }
};

const formatMoney = (val) => {
  if (val === null || val === undefined || val === '') return '0.00';
  const num = Number(val);
  return isNaN(num) ? String(val) : num.toFixed(2);
};

const formatStatus = (val) => String(val || '—').replace(/_/g, ' ').toUpperCase();

const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  let text = String(value).trim();
  // Formula injection defense (Excel security best practice)
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

const TAB_NAMES = {
  overview: 'overview',
  bookings: 'bookings',
  transactions: 'transactions',
  refunds: 'refunds-and-credits',
  outstanding: 'outstanding'
};

const transactionLines = (rows) => [
  ['Recognized At', 'Receipt No.', 'Booking Ref', 'Customer', 'Method', 'Status', 'Amount (PHP)', 'Reference'],
  ...rows.map((row) => [
    formatDate(row.recognized_at || row.created_at),
    `RCP-${row.payment_id}`,
    row.booking_id ? `#${String(row.booking_id).substring(0, 8).toUpperCase()}` : '—',
    row.customer_name || 'Customer',
    formatMethod(row.method),
    formatStatus(row.status),
    formatMoney(row.net_received),
    row.reference || ''
  ])
];

const refundLines = (rows) => [
  ['Created At', 'Booking Ref', 'Customer', 'Amount Refunded (PHP)'],
  ...rows.map((row) => [
    formatDate(row.created_at),
    row.booking_id ? `#${String(row.booking_id).substring(0, 8).toUpperCase()}` : '—',
    row.customer_name || 'Customer',
    formatMoney(Math.abs(row.amount))
  ])
];

/**
 * CSV of the tab that is open, for the date range that is chosen. Every figure comes from the same
 * database totals and ledger rows the screen shows, so a file always reconciles with the page. Transfer
 * fees are never exported: they exist only in the receipt reading.
 */
export async function downloadReportCsv({ tab = 'overview', range, method = 'ALL', report, daily = [] }) {
  const toLabel = new Date(range.to.getTime() - 1);
  const head = [
    ['COMAR GARAGE FINANCIAL REPORT', (TAB_NAMES[tab] || tab).toUpperCase()],
    ['Reporting Period', `${toDateParam(range.from)} to ${toDateParam(toLabel)}`],
    ['Generated On', formatDate(new Date())],
    []
  ];
  let body = [];
  let count = 0;

  if (tab === 'bookings') {
    const data = await fetchBookingsReport(range);
    const rows = data?.bookings || [];
    count = rows.length;
    body = [
      ['BOOKINGS SUMMARY'],
      ['Start Time', 'Reference', 'Customer', 'Status', 'Vehicles and Services', 'Total (PHP)', 'Paid (PHP)', 'Balance (PHP)', 'To Be Received (PHP)'],
      ...rows.map((b) => [
        formatDate(b.start_datetime),
        `#${String(b.reference || '').toUpperCase()}`,
        b.customer_name || 'Customer',
        formatStatus(b.status),
        (b.vehicles || []).map((v) => `${[v.brand, v.model].filter(Boolean).join(' ')} ${v.plate || ''}: ${(v.services || []).map((x) => x.name).join(' + ')}`.trim()).join(' | '),
        formatMoney(b.total),
        formatMoney(b.paid),
        formatMoney(b.balance),
        formatMoney(b.deferred)
      ])
    ];
  } else if (tab === 'transactions') {
    const [settled, pending] = await Promise.all([fetchAll(range, 'settled', method), fetchAll(range, 'pending', 'ALL')]);
    count = settled.length + pending.length;
    body = [
      ['SETTLED PAYMENTS (NET REVENUE)'],
      ...transactionLines(settled),
      [],
      ['AWAITING VERIFICATION (NOT COUNTED AS REVENUE YET)'],
      ...transactionLines(pending)
    ];
  } else if (tab === 'refunds') {
    const refunds = await fetchAll(range, 'refund', 'ALL');
    count = refunds.length;
    body = [
      ['REFUNDS SUMMARY'],
      ['Total Refunds in Range (PHP)', formatMoney(report?.refunds)],
      ['Overpayments Held (PHP)', formatMoney(report?.overpayments)],
      ['Customer Credit Liability (PHP)', formatMoney(report?.customer_credit_liability)],
      [],
      ['REFUND TRANSACTIONS'],
      ...refundLines(refunds)
    ];
  } else if (tab === 'outstanding') {
    const rows = await fetchOutstandingBookings({ limit: MAX_ROWS });
    count = rows.length;
    body = [
      ['OUTSTANDING BALANCES (AS OF NOW)'],
      ['Booking Ref', 'Customer', 'Appointment', 'Status', 'Total Expected (PHP)', 'Amount Settled (PHP)', 'Balance Owed (PHP)'],
      ...rows.map((row) => [
        `#${String(row.booking_id || '').substring(0, 8).toUpperCase()}`,
        row.customer_name || 'Customer',
        formatDate(row.start_datetime),
        formatStatus(row.booking_status),
        formatMoney(row.expected_amount),
        formatMoney(row.net_settled),
        formatMoney(row.outstanding_amount)
      ])
    ];
  } else {
    count = daily.length;
    body = [
      ['FINANCIAL OVERVIEW SUMMARY'],
      ['Net Revenue (PHP)', formatMoney(report?.net_revenue)],
      ['Net Received (PHP)', formatMoney(report?.net_received)],
      ['Refunds (PHP)', formatMoney(report?.refunds)],
      ['Pending Verification (PHP)', formatMoney(report?.pending_verification)],
      ['Outstanding Balance (PHP)', formatMoney(report?.outstanding_balance)],
      ['Customer Credit Liability (PHP)', formatMoney(report?.customer_credit_liability)],
      [],
      ['DAILY BREAKDOWN'],
      ['Day', 'Amount Received (PHP)', 'Refunds (PHP)', 'Pending Verification (PHP)', 'Transactions Count'],
      ...daily.map((d) => [d.day, formatMoney(d.net_received), formatMoney(d.refunds), formatMoney(d.pending_verification), d.transaction_count]),
      [],
      ['BY PAYMENT METHOD'],
      ['Method', 'Amount Received (PHP)', 'Payments Count'],
      ...(report?.by_method || []).map((m) => [formatMethod(m.method), formatMoney(m.net_received), m.count]),
      [],
      ['TOP SERVICES'],
      ['Service', 'Bookings Count'],
      ...(report?.top_services || []).map((t) => [t.name, t.count])
    ];
  }

  // Windows-standard CRLF line endings with clean escaping
  const csv = [...head, ...body].map((line) => line.map(csvCell).join(',')).join('\r\n');
  // Byte-order mark (BOM) so Excel opens UTF-8 without garbled characters or formatting corruption
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Comar-Garage-${TAB_NAMES[tab] || tab}_${toDateParam(range.from)}_${toDateParam(toLabel)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { rows: count, truncated: count >= MAX_ROWS };
}
