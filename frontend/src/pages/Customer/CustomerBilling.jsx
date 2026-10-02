import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, Clock, Printer, Copy, FileText } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import OfficialReceipt from '../../components/OfficialReceipt';
import { calculatePaymentSummary } from '../../utils/paymentUtils';

const CustomerBilling = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState([]);
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [selectedPayment, setSelectedPayment] = useState(null);

  const fetchData = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { data, error } = await supabase
        .from('bookings')
        .select('*, payments:payments!payments_booking_id_fkey(*), vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services!booking_vehicle_id(*))')
        .eq('customer_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      const processedBookings = (data || []).map(booking => ({
        ...booking,
        payments: (booking.payments || []).map(payment => {
          if (!payment.receipt_url || payment.receipt_url.startsWith('http')) return payment;
          const { data: { publicUrl } } = supabase.storage.from('payment-receipts').getPublicUrl(payment.receipt_url);
          return { ...payment, receipt_url: publicUrl };
        })
      }));
      setBookings(processedBookings);
    } catch (err) {
      console.error('Error fetching billing data:', err);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (user?.id) fetchData();
  }, [user?.id, fetchData]);

  const formatCurrency = (val) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(val || 0);
  const compactId = (value, prefix = '') => {
    const id = String(value || '');
    return `${prefix}${id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id}`;
  };
  const copyIdentifier = async (value, label) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is not available in this browser.');
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not copy ${label.toLowerCase()}.`);
    }
  };

  const totalSpent = bookings.reduce((sum, booking) => sum + calculatePaymentSummary(booking).totalPaid, 0);

  const outstandingBalance = bookings.reduce((sum, b) => {
    if (['confirmed', 'scheduled', 'in_progress'].includes(b.status?.toLowerCase())) {
      const totalPaid = calculatePaymentSummary(b).totalPaid;
      return sum + Math.max(0, (b.total_amount || 0) - totalPaid);
    }
    return sum;
  }, 0);

  const labelStyle = {
    fontSize: '0.65rem',
    fontWeight: '950',
    color: 'var(--admin-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '1px',
    marginBottom: '0.5rem',
    display: 'block'
  };

  if (loading) return <div style={{ padding: '2rem', color: 'var(--admin-text-secondary)', fontWeight: '600' }}>Synchronizing financial records...</div>;

  return (
    <>
      {(selectedReceipt || selectedPayment) && (
        <OfficialReceipt
          booking={selectedReceipt}
          vehicles={selectedReceipt?.vehicles || []}
          user={user}
          selectedPayment={selectedPayment}
          onClose={() => { setSelectedReceipt(null); setSelectedPayment(null); }}
          mode="modal"
        />
      )}

      {/* 📱 SCREEN UI */}
      <div id="screen-billing-content" style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem', paddingBottom: '5rem' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(1.8rem, 5vw, 2.5rem)', fontWeight: '950', margin: '0 0 0.5rem 0', textTransform: 'uppercase', color: 'var(--admin-text-primary)', letterSpacing: '-1.5px' }}>Billing & Invoices</h1>
          <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.95rem', fontWeight: '600', opacity: 0.8 }}>
            Operational ledger and digital archives of your DETAILING sessions.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
          <div style={{ background: 'var(--admin-card)', padding: '1.5rem', borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', gap: '1.5rem', boxShadow: 'var(--admin-card-shadow)' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: 'rgba(var(--admin-brand-rgb), 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(var(--admin-brand-rgb), 0.2)' }}>
              <CreditCard size={28} color="var(--admin-brand)" />
            </div>
            <div>
              <div style={labelStyle}>Total Invested</div>
              <div style={{ fontSize: '1.75rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>{formatCurrency(totalSpent)}</div>
            </div>
          </div>

          <div style={{ background: 'var(--admin-card)', padding: '1.5rem', borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', gap: '1.5rem', boxShadow: 'var(--admin-card-shadow)' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: 'rgba(245, 158, 11, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
              <Clock size={28} color="var(--status-warning)" />
            </div>
            <div>
              <div style={labelStyle}>Pending Balance</div>
              <div style={{ fontSize: '1.75rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>{formatCurrency(outstandingBalance)}</div>
            </div>
          </div>
        </div>

        <div style={{ background: 'var(--admin-card)', borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)', overflow: 'hidden', boxShadow: 'var(--admin-card-shadow)' }}>
          <div style={{ padding: '1.5rem 2rem', borderBottom: '1px solid var(--admin-border)', background: 'var(--admin-input-bg)' }}>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: '950', color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Transaction Ledger</h3>
          </div>

          <div className="billing-ledger-table-wrap" style={{ overflowX: 'auto' }}>
            <table className="billing-ledger-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '36%' }} />
                <col style={{ width: '16%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '19%' }} />
              </colgroup>
              <thead>
                <tr style={{ background: 'var(--admin-bg)', borderBottom: '1px solid var(--admin-border)' }}>
                  <th style={{ padding: '1.25rem 1.5rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Reference</th>
                  <th style={{ padding: '1.25rem 1rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Date</th>
                  <th style={{ padding: '1.25rem 2rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Amount</th>
                  <th style={{ padding: '1.25rem 1rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Status</th>
                  <th style={{ padding: '1.25rem 1rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {bookings.length === 0 ? (
                  <tr>
                    <td colSpan="5" style={{ padding: '4rem', textAlign: 'center', color: 'var(--admin-text-secondary)', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '1px' }}>No records in the current pipeline.</td>
                  </tr>
                ) : (
                  bookings.flatMap((booking) => {
                    const bookingPayments = (booking.payments || [])
                      .filter(p =>
                        ['PAID', 'REFUND_PENDING', 'REFUNDED', 'FOR_VERIFICATION', 'REJECTED'].includes(String(p.status || '').toUpperCase())
                        || (String(p.method || '').toUpperCase() === 'SYSTEM_REFUND' && Number(p.amount) < 0)
                      )
                      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

                    return bookingPayments.map((p) => {
                      const paymentStatus = String(p.status || '').toUpperCase();
                      const isRefund = String(p.method || '').toUpperCase() === 'SYSTEM_REFUND' && Number(p.amount) < 0;
                      const canIssueReceipt = Number(p.amount) > 0
                        && ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(paymentStatus)
                        && !isRefund;
                      const receiptNumber = `RCP-${p.id.toUpperCase()}`;
                      const paymentRecordNumber = `PAY-${p.id.toUpperCase()}`;
                      const transactionReference = p.reference_number || p.detected_ref || '';
                      const primaryReference = transactionReference || (isRefund ? `RFD-${p.id.toUpperCase()}` : paymentRecordNumber);
                      const shortReceiptNumber = compactId(p.id, 'RCP-');
                      const statusLabel = isRefund
                        ? 'REFUND'
                        : ({
                            PAID: 'VERIFIED',
                            REFUND_PENDING: 'REFUND PENDING',
                            REFUNDED: 'REFUNDED',
                            FOR_VERIFICATION: 'AWAITING VERIFICATION',
                            REJECTED: 'REJECTED',
                          }[paymentStatus] || paymentStatus);
                      const statusTone = ['REJECTED', 'REFUNDED'].includes(paymentStatus) || isRefund
                        ? 'danger'
                        : ['REFUND_PENDING', 'FOR_VERIFICATION'].includes(paymentStatus)
                          ? 'warning'
                          : 'success';

                      return (
                      <tr key={p.id} className="billing-ledger-row" style={{ borderBottom: '1px solid var(--admin-border)' }}>
                        <td className="billing-ledger-identifiers" style={{ padding: '1rem 1.5rem', color: 'var(--admin-text-primary)' }}>
                          <div className="billing-ledger-reference-line">
                            <strong title={primaryReference}>{primaryReference.length > 20 ? compactId(primaryReference) : primaryReference}</strong>
                            <button
                              type="button"
                              className="billing-ledger-copy"
                              onClick={() => copyIdentifier(primaryReference, isRefund ? 'Refund reference' : 'Transaction reference')}
                              aria-label={`Copy ${isRefund ? 'refund' : 'transaction'} reference`}
                              title="Copy reference"
                            >
                              <Copy size={13} />
                            </button>
                          </div>
                          <div className="billing-ledger-subdetails">
                            {canIssueReceipt && <span title={receiptNumber}>Receipt {shortReceiptNumber}</span>}
                            {!canIssueReceipt && !isRefund && <span title={paymentRecordNumber}>Payment {compactId(p.id, 'PAY-')}</span>}
                            <button
                              type="button"
                              className="billing-ledger-booking-link"
                              onClick={() => navigate(`/customer/bookings/${booking.id}`)}
                              title={`Open booking ${booking.id}`}
                            >
                              Booking #{booking.id.substring(0, 8).toUpperCase()}
                            </button>
                          </div>
                        </td>
                        <td data-label="Date" style={{ padding: '1.25rem 1rem', fontSize: '0.85rem', fontWeight: '700', color: 'var(--admin-text-secondary)' }}>
                          {p.created_at ? new Date(p.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
                        </td>
                        <td data-label="Amount" style={{ padding: '1.25rem 1rem', fontSize: '1.05rem', fontWeight: '850', color: Number(p.amount) < 0 ? 'var(--status-danger)' : 'var(--admin-text-primary)' }}>
                          {formatCurrency(p.amount)}
                        </td>
                        <td data-label="Status" style={{ padding: '1.25rem 1rem' }}>
                          <span className={`billing-ledger-status billing-ledger-status-${statusTone}`}>{statusLabel}</span>
                        </td>
                        <td data-label="Actions" style={{ padding: '1rem', textAlign: 'center' }}>
                          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                            {Number(p.amount) > 0 && p.receipt_url && (
                              <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); window.open(p.receipt_url, '_blank', 'noopener,noreferrer'); }}
                                title="View proof of payment"
                                className="billing-ledger-action"
                                aria-label="View proof of payment"
                                style={{ background: 'var(--admin-input-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', borderRadius: '8px', cursor: 'pointer' }}
                              >
                                <FileText size={16} /><span>Proof</span>
                              </button>
                            )}
                            {canIssueReceipt && <button
                              onClick={() => { setSelectedReceipt(booking); setSelectedPayment(p); }}
                              title={`View receipt ${receiptNumber}`}
                              className="billing-ledger-action"
                              aria-label="View receipt"
                              style={{ background: 'var(--admin-input-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', borderRadius: '8px', cursor: 'pointer' }}
                            >
                              <Printer size={16} /><span>Receipt</span>
                            </button>}
                          </div>
                        </td>
                      </tr>
                    );
                    });
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Second receipt view removed — handled by OfficialReceipt above */}
      </div>

      {/* 🖨️ PRINT-ONLY CSS ENGINE */}
      <style>{`
        .billing-ledger-table { min-width: 760px; }
        .billing-ledger-reference-line { display: flex; align-items: center; gap: 0.4rem; min-width: 0; font: 800 0.9rem/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .billing-ledger-reference-line strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .billing-ledger-copy { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 26px; height: 26px; border: 0; border-radius: 5px; background: transparent; color: var(--admin-text-secondary); cursor: pointer; opacity: 0.65; }
        .billing-ledger-copy:hover, .billing-ledger-copy:focus-visible { background: var(--admin-input-bg); opacity: 1; }
        .billing-ledger-subdetails { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.7rem; margin-top: 0.3rem; color: var(--admin-text-secondary); font-size: 0.68rem; }
        .billing-ledger-booking-link { background: transparent; border: 0; padding: 0; color: var(--admin-text-secondary); font: inherit; cursor: pointer; text-decoration: underline; text-decoration-color: var(--admin-border); text-underline-offset: 2px; }
        .billing-ledger-booking-link:hover { color: var(--admin-text-primary); }
        .billing-ledger-status { display: inline-flex; align-items: center; justify-content: center; max-width: 100%; padding: 0.35rem 0.65rem; border: 0; border-radius: 999px; font-size: 0.65rem; font-weight: 800; line-height: 1.2; text-align: center; white-space: nowrap; }
        .billing-ledger-status-warning { background: #fef3c7; color: #92400e; }
        .billing-ledger-status-success { background: #d1fae5; color: #065f46; }
        .billing-ledger-status-danger { background: #fee2e2; color: #991b1b; }
        .billing-ledger-action { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; min-height: 36px; padding: 0 0.6rem; font-size: 0.7rem; font-weight: 750; white-space: nowrap; }
        .billing-ledger-action:hover { border-color: var(--admin-text-secondary) !important; }
        @media (max-width: 700px) {
          .billing-ledger-table-wrap { overflow: visible !important; padding: 0.75rem; }
          .billing-ledger-table { display: block; width: 100%; }
          .billing-ledger-table thead { display: none; }
          .billing-ledger-table tbody { display: grid; gap: 0.75rem; }
          .billing-ledger-table tbody tr.billing-ledger-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "identifiers identifiers" "date status" "amount amount" "actions actions"; gap: 0; border: 1px solid var(--admin-border) !important; border-radius: 10px; background: var(--admin-bg); overflow: hidden; }
          .billing-ledger-table tbody td { min-width: 0; padding: 0.7rem 0.85rem !important; }
          .billing-ledger-table tbody td.billing-ledger-identifiers { grid-area: identifiers; border-bottom: 1px solid var(--admin-border); }
          .billing-ledger-table tbody td:nth-child(2) { grid-area: date; align-self: center; font-size: 0.78rem !important; }
          .billing-ledger-table tbody td:nth-child(3) { grid-area: amount; text-align: left; font-size: 1.25rem !important; font-weight: 850 !important; }
          .billing-ledger-table tbody td:nth-child(4) { grid-area: status; justify-self: end; align-self: center; }
          .billing-ledger-table tbody td:nth-child(5) { grid-area: actions; border-top: 1px solid var(--admin-border); }
          .billing-ledger-table tbody td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 0.2rem; color: var(--admin-text-secondary); font-size: 0.58rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
          .billing-ledger-table tbody td:nth-child(3)::before { content: "Amount"; }
          .billing-ledger-table tbody td:nth-child(5)::before { content: none; }
          .billing-ledger-status { font-size: 0.62rem; }
          .billing-ledger-table tbody td:nth-child(5) > div { justify-content: flex-start !important; gap: 0.5rem !important; }
          .billing-ledger-action { min-height: 38px; padding: 0 0.7rem; }
          .billing-ledger-reference-line { font-size: 0.82rem; }
          .billing-ledger-copy { width: 30px; height: 30px; opacity: 1; }
        }
        @media print {
          body * { visibility: hidden; }
          #printable-receipt, #printable-receipt * { visibility: visible; }
          #printable-receipt { position: absolute; left: 0; top: 0; width: 100%; background: #fff !important; color: #000 !important; }
          .no-print, .header-close-button, .action-buttons-container { display: none !important; }
          .price-column { font-variant-numeric: tabular-nums; text-align: right; }
          .invoice-content { page-break-inside: avoid; }
          @page { size: letter; margin: 0.5in; }
        }
      `}</style>
    </>
  );
};

export default CustomerBilling;
