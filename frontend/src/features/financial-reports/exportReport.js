import { fetchBookingsReport, fetchLedgerTransactions, fetchOutstandingBookings } from '@/services/ledgerService';
import { formatMethod } from '@/features/finance/money';
import { downloadWorkbook } from '@/lib/excelExport';
import { toDateParam } from './useReportRange';
import { formatReceiptNo } from '../../../../shared/receiptModel.ts';

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

const formatStatus = (val) => String(val || '—').replace(/_/g, ' ').toUpperCase();

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
const TAB_ORDER = ['overview', 'bookings', 'transactions', 'refunds', 'outstanding'];

const TRANSACTION_HEADERS = ['Recognized At', 'Receipt No.', 'Booking Ref', 'Customer', 'Method', 'Status', 'Amount (PHP)', 'Reference'];
const TRANSACTION_FORMATS = ['text', 'text', 'text', 'text', 'text', 'text', 'money', 'text'];
const transactionRows = (rows) => rows.map((row) => [
  formatDate(row.recognized_at || row.created_at),
  formatReceiptNo(row.receipt_no) || '—',
  row.booking_id ? `#${String(row.booking_id).substring(0, 8).toUpperCase()}` : '—',
  row.customer_name || 'Customer',
  formatMethod(row.method),
  formatStatus(row.status),
  Number(row.net_received || 0),
  row.reference || ''
]);

const REFUND_HEADERS = ['Created At', 'Booking Ref', 'Customer', 'Amount Refunded (PHP)'];
const REFUND_FORMATS = ['text', 'text', 'text', 'money'];
const refundRows = (rows) => rows.map((row) => [
  formatDate(row.created_at),
  row.booking_id ? `#${String(row.booking_id).substring(0, 8).toUpperCase()}` : '—',
  row.customer_name || 'Customer',
  Math.abs(Number(row.amount || 0))
]);

/** Builds the section blocks (and row count) for a single tab. Each tab fetches its own ledger rows,
 * independent of which tab is open on screen, so every sheet in the bundled workbook is complete. */
async function buildTabSections(tab, { range, method, report, daily }) {
  if (tab === 'bookings') {
    const data = await fetchBookingsReport(range);
    const rows = data?.bookings || [];
    return {
      count: rows.length,
      sections: [{
        type: 'section',
        title: 'BOOKINGS SUMMARY',
        headers: ['Start Time', 'Reference', 'Customer', 'Status', 'Vehicles and Services', 'Total (PHP)', 'Paid (PHP)', 'Balance (PHP)', 'To Be Received (PHP)'],
        formats: ['text', 'text', 'text', 'text', 'text', 'money', 'money', 'money', 'money'],
        rows: rows.map((b) => [
          formatDate(b.start_datetime),
          `#${String(b.reference || '').toUpperCase()}`,
          b.customer_name || 'Customer',
          formatStatus(b.status),
          (b.vehicles || []).map((v) => `${[v.brand, v.model].filter(Boolean).join(' ')} ${v.plate || ''}: ${(v.services || []).map((x) => x.name).join(' + ')}`.trim()).join(' | '),
          Number(b.total || 0),
          Number(b.paid || 0),
          Number(b.balance || 0),
          Number(b.deferred || 0)
        ])
      }]
    };
  }
  if (tab === 'transactions') {
    const [settled, pending] = await Promise.all([fetchAll(range, 'settled', method), fetchAll(range, 'pending', 'ALL')]);
    return {
      count: settled.length + pending.length,
      sections: [
        { type: 'section', title: 'SETTLED PAYMENTS (NET REVENUE)', headers: TRANSACTION_HEADERS, formats: TRANSACTION_FORMATS, rows: transactionRows(settled) },
        { type: 'spacer' },
        { type: 'section', title: 'AWAITING VERIFICATION (NOT COUNTED AS REVENUE YET)', headers: TRANSACTION_HEADERS, formats: TRANSACTION_FORMATS, rows: transactionRows(pending) }
      ]
    };
  }
  if (tab === 'refunds') {
    const refunds = await fetchAll(range, 'refund', 'ALL');
    return {
      count: refunds.length,
      sections: [
        {
          type: 'section',
          title: 'REFUNDS SUMMARY',
          formats: ['text', 'money'],
          rows: [
            ['Total Refunds in Range (PHP)', Number(report?.refunds || 0)],
            ['Overpayments Held (PHP)', Number(report?.overpayments || 0)],
            ['Customer Credit Liability (PHP)', Number(report?.customer_credit_liability || 0)]
          ]
        },
        { type: 'spacer' },
        { type: 'section', title: 'REFUND TRANSACTIONS', headers: REFUND_HEADERS, formats: REFUND_FORMATS, rows: refundRows(refunds) }
      ]
    };
  }
  if (tab === 'outstanding') {
    const rows = await fetchOutstandingBookings({ limit: MAX_ROWS });
    return {
      count: rows.length,
      sections: [{
        type: 'section',
        title: 'OUTSTANDING BALANCES (AS OF NOW)',
        headers: ['Booking Ref', 'Customer', 'Appointment', 'Status', 'Total Expected (PHP)', 'Amount Settled (PHP)', 'Balance Owed (PHP)'],
        formats: ['text', 'text', 'text', 'text', 'money', 'money', 'money'],
        rows: rows.map((row) => [
          `#${String(row.booking_id || '').substring(0, 8).toUpperCase()}`,
          row.customer_name || 'Customer',
          formatDate(row.start_datetime),
          formatStatus(row.booking_status),
          Number(row.expected_amount || 0),
          Number(row.net_settled || 0),
          Number(row.outstanding_amount || 0)
        ])
      }]
    };
  }
  // overview
  return {
    count: daily.length,
    sections: [
      {
        type: 'section',
        title: 'FINANCIAL OVERVIEW SUMMARY',
        formats: ['text', 'money'],
        rows: [
          ['Gross Sales (PHP)', Number(report?.gross_sales || 0)],
          ['Discounts & Promos (PHP)', Number(report?.discounts || 0)],
          ['Net Sales (PHP)', Number(report?.net_sales || 0)],
          ['Average Sale (PHP)', Number(report?.average_sale || 0)],
          ['Refunds (PHP)', Number(report?.refunds || 0)],
          ['Pending Verification (PHP)', Number(report?.pending_verification || 0)],
          ['Outstanding Balance (PHP)', Number(report?.outstanding_balance || 0)],
          ['Deferred Receivables (PHP)', Number(report?.deferred_receivables || 0)],
          ['Customer Credit (PHP)', Number(report?.customer_credit_liability || 0)]
        ]
      },
      { type: 'spacer' },
      {
        type: 'section',
        title: 'DAILY BREAKDOWN',
        headers: ['Day', 'Amount Received (PHP)', 'Refunds (PHP)', 'Pending Verification (PHP)', 'Transactions Count'],
        formats: ['text', 'money', 'money', 'money', 'int'],
        rows: daily.map((d) => [d.day, Number(d.net_received || 0), Number(d.refunds || 0), Number(d.pending_verification || 0), Number(d.transaction_count || 0)])
      },
      { type: 'spacer' },
      {
        type: 'section',
        title: 'BY PAYMENT METHOD',
        headers: ['Method', 'Amount Received (PHP)', 'Payments Count'],
        formats: ['text', 'money', 'int'],
        rows: (report?.by_method || []).map((m) => [formatMethod(m.method), Number(m.net_received || 0), Number(m.count || 0)])
      },
      { type: 'spacer' },
      {
        type: 'section',
        title: 'TOP SERVICES',
        headers: ['Service', 'Bookings Count'],
        formats: ['text', 'int'],
        rows: (report?.top_services || []).map((t) => [t.name, Number(t.count || 0)])
      }
    ]
  };
}

/**
 * A formatted, print-ready .xlsx with every report tab (overview, bookings, transactions, refunds,
 * outstanding) bundled as its own sheet, for the date range that is chosen. Every figure comes from
 * the same database totals and ledger rows the screen shows, so the file always reconciles with the
 * page. Transfer fees are never exported: they exist only in the receipt reading.
 */
export async function downloadReportCsv({ range, method = 'ALL', report, daily = [] }) {
  const toLabel = new Date(range.to.getTime() - 1);
  const meta = [
    ['Reporting Period', `${toDateParam(range.from)} to ${toDateParam(toLabel)}`],
    ['Generated On', formatDate(new Date())]
  ];

  const results = await Promise.all(TAB_ORDER.map((tab) => buildTabSections(tab, { range, method, report, daily })));
  const totalRows = results.reduce((sum, r) => sum + r.count, 0);
  const sheets = TAB_ORDER.map((tab, i) => ({
    name: TAB_NAMES[tab],
    span: 9,
    blocks: [
      { type: 'title', text: `COMAR GARAGE FINANCIAL REPORT — ${TAB_NAMES[tab].toUpperCase()}` },
      { type: 'meta', rows: meta },
      { type: 'spacer' },
      ...results[i].sections
    ]
  }));

  await downloadWorkbook({
    fileName: `Comar-Garage-financial-report_${toDateParam(range.from)}_${toDateParam(toLabel)}`,
    sheets
  });
  return { rows: totalRows, truncated: results.some((r) => r.count >= MAX_ROWS) };
}
