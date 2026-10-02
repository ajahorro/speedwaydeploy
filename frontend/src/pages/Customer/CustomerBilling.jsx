import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, Clock, Printer } from 'lucide-react';
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

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ background: 'var(--admin-bg)', borderBottom: '1px solid var(--admin-border)' }}>
                  <th style={{ padding: '1.25rem 2rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Receipt No. / Reference ID</th>
                  <th style={{ padding: '1.25rem 2rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Transaction Date</th>
                  <th style={{ padding: '1.25rem 2rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Amount</th>
                  <th style={{ padding: '1.25rem 2rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Status</th>
                  <th style={{ padding: '1.25rem 2rem', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', textAlign: 'center' }}>Actions</th>
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
                      const statusLabel = isRefund
                        ? 'REFUND'
                        : ({
                            PAID: 'VERIFIED',
                            REFUND_PENDING: 'REFUND PENDING',
                            REFUNDED: 'REFUNDED',
                            FOR_VERIFICATION: 'AWAITING VERIFICATION',
                            REJECTED: 'REJECTED',
                          }[paymentStatus] || paymentStatus);
                      const statusColor = ['REJECTED', 'REFUNDED'].includes(paymentStatus) || isRefund
                        ? 'var(--status-danger)'
                        : ['REFUND_PENDING', 'FOR_VERIFICATION'].includes(paymentStatus)
                          ? 'var(--status-warning)'
                          : 'var(--status-success)';
                      const statusBackground = ['REJECTED', 'REFUNDED'].includes(paymentStatus) || isRefund
                        ? 'rgba(239, 68, 68, 0.1)'
                        : ['REFUND_PENDING', 'FOR_VERIFICATION'].includes(paymentStatus)
                          ? 'rgba(245, 158, 11, 0.1)'
                          : 'rgba(16, 185, 129, 0.1)';

                      return (
                      <tr key={p.id} style={{ borderBottom: '1px solid var(--admin-border)' }}>
                        <td style={{ padding: '1.25rem 2rem', fontSize: '0.95rem', fontWeight: '900', color: 'var(--admin-text-primary)', fontFamily: 'monospace' }}>
                          <div>{isRefund ? 'Refund Reference ID' : canIssueReceipt ? 'Receipt No.' : 'Payment Record ID'}: {isRefund ? (p.reference_number || `RFD-${p.id.toUpperCase()}`) : canIssueReceipt ? receiptNumber : paymentRecordNumber}</div>
                          {!isRefund && <div style={{ marginTop: '0.2rem', fontSize: '0.68rem', fontWeight: 700, overflowWrap: 'anywhere' }}>Transaction/Reference ID: {p.reference_number || p.detected_ref || 'Not provided'}</div>}
                          <button
                            type="button"
                            onClick={() => navigate(`/customer/bookings/${booking.id}`)}
                            style={{ display: 'block', background: 'none', border: 0, padding: 0, marginTop: '0.2rem', color: 'var(--admin-brand)', fontSize: '0.6rem', fontWeight: '950', cursor: 'pointer' }}
                          >
                            LINKED TO INV-{booking.id.substring(0, 8).toUpperCase()}
                          </button>
                        </td>
                        <td style={{ padding: '1.25rem 2rem', fontSize: '0.85rem', fontWeight: '700', color: 'var(--admin-text-secondary)' }}>
                          {p.created_at ? new Date(p.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
                        </td>
                        <td style={{ padding: '1.25rem 2rem', fontSize: '1.1rem', fontWeight: '950', color: 'var(--admin-brand)' }}>
                          <span style={{ color: Number(p.amount) < 0 ? 'var(--status-danger)' : 'var(--admin-brand)' }}>{formatCurrency(p.amount)}</span>
                        </td>
                        <td style={{ padding: '1.25rem 2rem' }}>
                          <span style={{
                            fontSize: '0.65rem', fontWeight: '950',
                            background: statusBackground,
                            color: statusColor,
                            padding: '0.3rem 0.75rem', borderRadius: '4px', textTransform: 'uppercase', border: '1px solid currentColor'
                          }}>
                            {statusLabel}
                          </span>
                        </td>
                        <td style={{ padding: '1.25rem 2rem', textAlign: 'center' }}>
                          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                            {Number(p.amount) > 0 && p.receipt_url && (
                              <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); window.open(p.receipt_url, '_blank', 'noopener,noreferrer'); }}
                                title="View proof of payment"
                                style={{
                                  background: 'var(--admin-input-bg)', border: '1px solid var(--admin-border)',
                                  color: 'var(--admin-text-primary)', borderRadius: '8px', padding: '0 0.7rem',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                                  fontSize: '0.62rem', fontWeight: '900', textTransform: 'uppercase'
                                }}
                              >
                                View Proof
                              </button>
                            )}
                            {canIssueReceipt && <button
                              onClick={() => { setSelectedReceipt(booking); setSelectedPayment(p); }}
                              title={`View receipt ${receiptNumber}`}
                              style={{ 
                                background: 'var(--admin-input-bg)', border: '1px solid var(--admin-border)',
                                color: 'var(--admin-text-primary)', borderRadius: '8px', padding: '0 0.65rem', minHeight: '40px',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
                              }}
                            >
                              <><Printer size={16} /><span style={{ marginLeft: '0.3rem', fontSize: '0.62rem', fontWeight: 900 }}>RECEIPT</span></>
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
