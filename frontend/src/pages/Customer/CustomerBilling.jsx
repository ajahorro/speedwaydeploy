import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, Clock, Printer } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import OfficialReceipt from '../../components/OfficialReceipt';
import { calculatePaymentSummary } from '../../utils/paymentUtils';
import { fetchBookingLedgers } from '../../services/ledgerService';
import { useImagePreview } from '../../context/ImagePreviewContext';
import RefundProofButton from '../../features/finance/RefundProofButton';
import { useRefundProofs } from '../../hooks/useRefundProofs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const CustomerBilling = () => {
  const { openImage } = useImagePreview();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState([]);
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [selectedPayment, setSelectedPayment] = useState(null);
  const { proofFor: refundProofFor } = useRefundProofs(bookings.map((booking) => booking.id));

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
      // Money for every booking comes from the ledger in one request.
      const ledgers = await fetchBookingLedgers(processedBookings.map((booking) => booking.id));
      setBookings(processedBookings.map((booking) => ({ ...booking, ledger: ledgers.get(booking.id) || null })));
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

  const outstandingBalance = bookings.reduce((sum, b) => (
    ['confirmed', 'scheduled', 'in_progress'].includes(b.status?.toLowerCase())
      ? sum + calculatePaymentSummary(b).balance
      : sum
  ), 0);

  if (loading) {
    return (
      <div className="ui-root grid gap-4 p-2" aria-busy="true">
        <p className="text-sm font-semibold text-muted-foreground">Synchronizing financial records...</p>
        <Skeleton className="h-20 w-full" /><Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const TONES = {
    danger: 'border-destructive/40 bg-destructive/10 text-destructive',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  };

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

      {/* Screen UI */}
      <div id="screen-billing-content" className="ui-root flex flex-col gap-8 pb-20">
        <div>
          <h1 className="text-3xl font-black uppercase tracking-tight">Billing &amp; Invoices</h1>
          <p className="mt-1 text-sm text-muted-foreground">Operational ledger and digital archives of your DETAILING sessions.</p>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
          <Card className="flex-row items-center gap-4 rounded-md p-5">
            <span className="grid size-12 place-items-center rounded-md border border-primary/30 bg-primary/10"><CreditCard className="size-6 text-primary" aria-hidden="true" /></span>
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">Total Invested</p>
              <p className="text-2xl font-black">{formatCurrency(totalSpent)}</p>
            </div>
          </Card>
          <Card className="flex-row items-center gap-4 rounded-md p-5">
            <span className="grid size-12 place-items-center rounded-md border border-amber-500/30 bg-amber-500/10"><Clock className="size-6 text-amber-500" aria-hidden="true" /></span>
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">Pending Balance</p>
              <p className="text-2xl font-black">{formatCurrency(outstandingBalance)}</p>
            </div>
          </Card>
        </div>

        <Card className="gap-0 overflow-hidden rounded-md p-0">
          <div className="border-b bg-muted/40 px-5 py-4">
            <h2 className="text-sm font-bold uppercase tracking-wide">Transaction Ledger</h2>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-5 text-xs uppercase">Receipt No. / Reference ID</TableHead>
                <TableHead className="px-5 text-xs uppercase">Transaction Date</TableHead>
                <TableHead className="px-5 text-xs uppercase">Amount</TableHead>
                <TableHead className="px-5 text-xs uppercase">Status</TableHead>
                <TableHead className="px-5 text-center text-xs uppercase">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bookings.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center text-sm font-semibold uppercase text-muted-foreground">No records in the current pipeline.</TableCell>
                </TableRow>
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
                    const canIssueReceipt = isRefund || (Number(p.amount) > 0
                      && ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(paymentStatus));
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
                    const tone = ['REJECTED', 'REFUNDED'].includes(paymentStatus) || isRefund
                      ? 'danger'
                      : ['REFUND_PENDING', 'FOR_VERIFICATION'].includes(paymentStatus)
                        ? 'warning'
                        : 'success';

                    return (
                      <TableRow key={p.id}>
                        <TableCell className="px-5 py-4 align-top font-mono">
                          <p className="text-sm font-bold">{isRefund ? 'Refund Reference ID' : canIssueReceipt ? 'Receipt No.' : 'Payment Record ID'}: {isRefund ? (p.reference_number || `RFD-${p.id.toUpperCase()}`) : canIssueReceipt ? receiptNumber : paymentRecordNumber}</p>
                          {!isRefund && <p className="mt-1 break-all text-xs">Transaction/Reference ID: {p.reference_number || p.detected_ref || 'Not provided'}</p>}
                          <Button
                            type="button"
                            variant="link"
                            size="xs"
                            className="mt-1 h-auto p-0 text-[0.65rem] font-bold"
                            onClick={() => navigate(`/customer/bookings/${booking.id}`)}
                          >
                            LINKED TO INV-{booking.id.substring(0, 8).toUpperCase()}
                          </Button>
                        </TableCell>
                        <TableCell className="px-5 py-4 text-sm text-muted-foreground">
                          {p.created_at ? new Date(p.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
                        </TableCell>
                        <TableCell className={`px-5 py-4 text-base font-bold ${Number(p.amount) < 0 ? 'text-destructive' : 'text-primary'}`}>
                          {formatCurrency(p.amount)}
                        </TableCell>
                        <TableCell className="px-5 py-4">
                          <Badge variant="outline" className={`whitespace-nowrap uppercase ${TONES[tone]}`}>{statusLabel}</Badge>
                        </TableCell>
                        <TableCell className="px-5 py-4">
                          <div className="flex justify-center gap-2">
                            {Number(p.amount) > 0 && p.receipt_url && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="text-xs uppercase"
                                onClick={(event) => { event.stopPropagation(); openImage(p.receipt_url, { alt: 'Proof of payment' }); }}
                                title="View proof of payment"
                              >
                                View Proof
                              </Button>
                            )}
                            {isRefund && <RefundProofButton proof={refundProofFor(p)} />}
                            {canIssueReceipt && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="text-xs uppercase"
                                onClick={() => { setSelectedReceipt(booking); setSelectedPayment(p); }}
                                title={`View receipt ${receiptNumber}`}
                              >
                                <Printer /> Receipt
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  });
                })
              )}
            </TableBody>
          </Table>
        </Card>

        {/* Second receipt view removed — handled by OfficialReceipt above */}
      </div>

      {/*PRINT-ONLY CSS ENGINE */}
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
