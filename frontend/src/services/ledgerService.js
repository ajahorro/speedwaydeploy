import { supabase } from '../lib/supabase';

/**
 * Booking money — read-only access to the database ledger.
 *
 * Every paid / balance / refund / revenue figure in the app must come from
 * these functions. They read the views and RPCs defined in migration
 * 20261024000003_canonical_booking_ledger.sql:
 *
 *   payment_ledger_v   one row per payment (net_received, gross_paid, flags)
 *   booking_ledger_v   one row per booking (net_settled, verified_paid,
 *                      outstanding_amount, required_downpayment, paid_status…)
 *   sales_report()     admin KPI totals for a date window
 *   sales_report_daily() admin daily series for the same window
 *
 * Never sum `payments` rows in the browser: that is how screens drifted apart.
 */

const LEDGER_NUMBERS = [
  'original_amount', 'expected_amount', 'settled_amount', 'refunded_amount', 'net_settled',
  'verified_paid', 'outstanding_amount', 'excess_amount', 'pending_verification',
  'pending_ocr_detected', 'pending_declared', 'ocr_variance', 'ocr_transfer_fee',
  'settled_transfer_fee', 'credit_applied', 'required_downpayment', 'downpayment_rate',
  'service_balance_due'
];

const PAYMENT_NUMBERS = [
  'amount', 'declared_amount', 'detected_amount', 'verified_amount', 'transfer_fee',
  'credit_applied', 'net_received', 'gross_paid', 'ledger_effect'
];

const toNumbers = (row, fields) => {
  if (!row) return row;
  const next = { ...row };
  for (const field of fields) {
    if (next[field] !== null && next[field] !== undefined) next[field] = Number(next[field]);
  }
  return next;
};

export const normalizeBookingLedger = (row) => toNumbers(row, LEDGER_NUMBERS);
export const normalizePaymentLedger = (row) => toNumbers(row, PAYMENT_NUMBERS);

/** Ledger for one booking, or null when the caller cannot see it. */
export const fetchBookingLedger = async (bookingId) => {
  if (!bookingId) return null;
  const { data, error } = await supabase
    .from('booking_ledger_v')
    .select('*')
    .eq('booking_id', bookingId)
    .maybeSingle();
  if (error) throw error;
  return normalizeBookingLedger(data);
};

/** Ledgers for many bookings in ONE request, keyed by booking id. */
export const fetchBookingLedgers = async (bookingIds = []) => {
  const ids = [...new Set((bookingIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase.rpc('booking_ledgers', { p_booking_ids: ids });
  if (error) throw error;
  return new Map((data || []).map((row) => [row.booking_id, normalizeBookingLedger(row)]));
};

/** Bookings that still owe money, largest balance first. */
export const fetchOutstandingBookings = async ({ limit = 200 } = {}) => {
  const { data, error } = await supabase
    .from('booking_ledger_v')
    .select('booking_id, customer_name, booking_status, start_datetime, expected_amount, net_settled, outstanding_amount, pending_verification, paid_status')
    .gt('outstanding_amount', 0)
    .not('booking_status', 'in', '("cancelled","CANCELLED","released","RELEASED","no_show","NO_SHOW","flagged_noshow","FLAGGED_NOSHOW")')
    .order('outstanding_amount', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(normalizeBookingLedger);
};

/** Admin KPI totals for [from, to). */
export const fetchSalesReport = async ({ from, to }) => {
  const { data, error } = await supabase.rpc('sales_report', {
    p_from: from.toISOString(),
    p_to: to.toISOString()
  });
  if (error) throw error;
  return data;
};

/** Admin daily series for [from, to), bucketed in shop local time. */
export const fetchSalesReportDaily = async ({ from, to }) => {
  const { data, error } = await supabase.rpc('sales_report_daily', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_tz: 'Asia/Manila'
  });
  if (error) throw error;
  return (data || []).map((row) => ({
    day: row.day,
    net_received: Number(row.net_received || 0),
    refunds: Number(row.refunds || 0),
    pending_verification: Number(row.pending_verification || 0),
    transaction_count: Number(row.transaction_count || 0)
  }));
};

/**
 * Ledger transactions in [from, to) for reports.
 * kind: 'settled' (money received), 'refund', 'pending', or 'all'.
 */
export const fetchLedgerTransactions = async ({ from, to, kind = 'settled', method = 'ALL', page = 0, pageSize = 25 }) => {
  let query = supabase
    .from('payment_ledger_v')
    .select('*', { count: 'exact' });

  if (kind === 'settled') {
    query = query.eq('is_settled_credit', true)
      .gte('recognized_at', from.toISOString())
      .lt('recognized_at', to.toISOString())
      .order('recognized_at', { ascending: false });
  } else {
    if (kind === 'refund') query = query.eq('is_refund', true);
    if (kind === 'pending') query = query.eq('is_pending', true);
    query = query.gte('created_at', from.toISOString())
      .lt('created_at', to.toISOString())
      .order('created_at', { ascending: false });
  }

  if (method && method !== 'ALL') query = query.eq('method', method);
  if (pageSize) query = query.range(page * pageSize, page * pageSize + pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data || []).map(normalizePaymentLedger), total: count || 0 };
};

/** Every ledger transaction (payments and refunds) for one booking, oldest first. */
export const fetchBookingTransactions = async (bookingId) => {
  if (!bookingId) return [];
  const { data, error } = await supabase
    .from('payment_ledger_v')
    .select('*')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(normalizePaymentLedger);
};

/** Downpayment required for a total that is not saved yet (wizard preview). */
export const fetchRequiredDownpayment = async (total) => {
  const { data, error } = await supabase.rpc('booking_required_downpayment', { p_total: Number(total || 0) });
  if (error) throw error;
  return Number(data || 0);
};
