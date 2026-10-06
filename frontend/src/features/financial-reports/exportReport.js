import { fetchBookingsReport, fetchLedgerTransactions, fetchOutstandingBookings } from '@/services/ledgerService';
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

const TAB_NAMES = {
  overview: 'overview',
  bookings: 'bookings',
  transactions: 'transactions',
  refunds: 'refunds-and-credits',
  outstanding: 'outstanding'
};

const transactionLines = (rows) => [
  ['Recognized at', 'Receipt no.', 'Booking', 'Customer', 'Method', 'Status', 'Amount received', 'Reference'],
  ...rows.map((row) => [
    row.recognized_at || row.created_at, `RCP-${row.payment_id}`, row.booking_id, row.customer_name, formatMethod(row.method),
    row.status, row.net_received, row.reference
  ])
];

const refundLines = (rows) => [
  ['Created at', 'Booking', 'Customer', 'Amount refunded'],
  ...rows.map((row) => [row.created_at, row.booking_id, row.customer_name, Math.abs(row.amount)])
];

/**
 * CSV of the tab that is open, for the date range that is chosen. Every figure comes from the same
 * database totals and ledger rows the screen shows, so a file always reconciles with the page. Transfer
 * fees are never exported: they exist only in the receipt reading.
 */
export async function downloadReportCsv({ tab = 'overview', range, method = 'ALL', report, daily = [] }) {
  const toLabel = new Date(range.to.getTime() - 1);
  const head = [
    ['Comar Garage report', TAB_NAMES[tab] || tab],
    ['From', toDateParam(range.from), 'To', toDateParam(toLabel)],
    []
  ];
  let body = [];
  let count = 0;

  if (tab === 'bookings') {
    const data = await fetchBookingsReport(range);
    const rows = data?.bookings || [];
    count = rows.length;
    body = [
      ['Bookings'],
      ['Start', 'Reference', 'Customer', 'Status', 'Vehicles and services', 'Total', 'Paid', 'Balance', 'To be received'],
      ...rows.map((b) => [
        b.start_datetime, b.reference, b.customer_name, b.status,
        (b.vehicles || []).map((v) => `${[v.brand, v.model].filter(Boolean).join(' ')} ${v.plate || ''}: ${(v.services || []).map((x) => x.name).join(' + ')}`.trim()).join(' | '),
        b.total, b.paid, b.balance, b.deferred
      ])
    ];
  } else if (tab === 'transactions') {
    const [settled, pending] = await Promise.all([fetchAll(range, 'settled', method), fetchAll(range, 'pending', 'ALL')]);
    count = settled.length + pending.length;
    body = [['Money received'], ...transactionLines(settled), [], ['Awaiting verification (not counted as revenue)'], ...transactionLines(pending)];
  } else if (tab === 'refunds') {
    const refunds = await fetchAll(range, 'refund', 'ALL');
    count = refunds.length;
    body = [
      ['Summary'],
      ['Refunds in range', report?.refunds],
      ['Overpayments held', report?.overpayments],
      ['Customer credit (today)', report?.customer_credit_liability],
      [],
      ['Refund transactions'],
      ...refundLines(refunds)
    ];
  } else if (tab === 'outstanding') {
    const rows = await fetchOutstandingBookings({ limit: MAX_ROWS });
    count = rows.length;
    body = [
      ['Outstanding balances (as of now)'],
      ['Booking', 'Customer', 'Appointment', 'Status', 'Total', 'Paid', 'Owed'],
      ...rows.map((row) => [row.booking_id, row.customer_name, row.start_datetime, row.booking_status, row.expected_amount, row.net_settled, row.outstanding_amount])
    ];
  } else {
    count = daily.length;
    body = [
      ['Summary'],
      ['Net revenue', report?.net_revenue],
      ['Net received', report?.net_received],
      ['Refunds', report?.refunds],
      ['Pending verification', report?.pending_verification],
      ['Outstanding balance (today)', report?.outstanding_balance],
      ['Customer credit (today)', report?.customer_credit_liability],
      [],
      ['By day'],
      ['Day', 'Amount received', 'Refunds', 'Pending verification', 'Transactions'],
      ...daily.map((d) => [d.day, d.net_received, d.refunds, d.pending_verification, d.transaction_count]),
      [],
      ['By payment method'],
      ['Method', 'Amount received', 'Payments'],
      ...(report?.by_method || []).map((m) => [formatMethod(m.method), m.net_received, m.count]),
      [],
      ['Top services'],
      ['Service', 'Bookings'],
      ...(report?.top_services || []).map((t) => [t.name, t.count])
    ];
  }

  const csv = [...head, ...body].map((line) => line.map(csvCell).join(',')).join('\n');
  // Byte-order mark so Excel opens the file as UTF-8 (₱ and names render correctly).
  const blob = new Blob([String.fromCharCode(0xfeff), csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `report-${TAB_NAMES[tab] || tab}_${toDateParam(range.from)}_${toDateParam(toLabel)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { rows: count, truncated: count >= MAX_ROWS };
}
