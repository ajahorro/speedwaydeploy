import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchBookingLedger, fetchBookingTransactions } from '../../services/ledgerService';
import { StatementOfAccount } from '../../features/finance/StatementOfAccount';

/**
 * CustomerReceipt — the booking's Statement of Account (cumulative receipt).
 * Route: /customer/receipt/:id  (where :id is the booking ID)
 *
 * Totals come from the database ledger and lines from payment_ledger_v, the
 * same sources as the Statement of Account PDF the customer receives by email.
 * Individual payments keep their own per-transaction receipts.
 */
const CustomerReceipt = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  const [state, setState] = useState({ booking: null, ledger: null, transactions: [], loading: true, error: null });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [{ data: booking, error: bookingError }, ledger, transactions] = await Promise.all([
          supabase
            .from('bookings')
            .select(`
              *,
              customer:profiles!bookings_customer_id_fkey(full_name, email),
              vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(
                *,
                services:booking_vehicle_services!booking_vehicle_id(*)
              )
            `)
            .eq('id', id)
            .single(),
          fetchBookingLedger(id),
          fetchBookingTransactions(id)
        ]);
        if (bookingError) throw bookingError;
        if (!booking) throw new Error('Booking not found');
        if (!cancelled) setState({ booking, ledger, transactions, loading: false, error: null });
      } catch (e) {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false, error: e.message }));
      }
    };
    load();
    return () => { cancelled = true; };
  }, [id]);

  if (state.loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#F3F4F6' }}>
        <div style={{ fontSize: '0.9rem', color: '#6B7280', fontWeight: '600' }}>Generating statement...</div>
      </div>
    );
  }

  if (state.error || !state.booking) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#F3F4F6', gap: '1rem' }}>
        <div style={{ fontSize: '0.9rem', color: '#EF4444', fontWeight: '700' }}>Unable to load statement: {state.error}</div>
        <button onClick={() => navigate(-1)} style={{ padding: '0.6rem 1.25rem', background: '#111827', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: '800', fontSize: '0.8rem' }}>
          Go Back
        </button>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F3F4F6', padding: '4rem 1rem 2rem' }}>
      {/* Back button — hidden on print */}
      <div className="no-print" style={{ position: 'fixed', top: '1rem', left: '1rem', zIndex: 100 }}>
        <button
          onClick={() => navigate(-1)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', background: '#111827', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: '700', fontSize: '0.78rem' }}
        >
          <ArrowLeft size={14} /> Back
        </button>
      </div>

      <StatementOfAccount
        booking={state.booking}
        vehicles={state.booking.vehicles || []}
        ledger={state.ledger}
        transactions={state.transactions}
      />
    </div>
  );
};

export default CustomerReceipt;
