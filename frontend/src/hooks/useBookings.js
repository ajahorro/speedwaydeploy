import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, createUniqueChannel } from '../lib/supabase';
import { fetchCustomerBookings } from '../services/bookingService';
import { calculatePaymentStatus } from '../utils/paymentUtils';

/**
 * useBookings hook — PRODUCTION GRADE
 * Real-time subscription with debounce stabilization.
 * Returns: { bookings, activeBooking, upcomingBookings, pastBookings, loading, refresh }
 */
export const useBookings = (customerId) => {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef(null);
  const channelRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    try {
      const data = await fetchCustomerBookings(customerId);

      // fetchCustomerBookings attaches each booking's ledger; status is derived from it.
      const enriched = data.map((b) => ({ ...b, paymentStatus: calculatePaymentStatus(b) }));

      setBookings(enriched);
    } catch (err) {
      console.error('useBookings fetch error details:', {
        message: err?.message || err,
        details: err?.details,
        hint: err?.hint,
        code: err?.code,
        raw: err
      });
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  // Debounced refresh — prevents rapid-fire re-fetches from multiple real-time events
  const debouncedRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      refresh();
    }, 300); // 300ms debounce window
  }, [refresh]);

  useEffect(() => {
    refresh();

    if (!customerId) return;

    // Unified multi-table subscription
    const channel = createUniqueChannel(`customer-bookings-unified-${customerId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'bookings',
        filter: `customer_id=eq.${customerId}`
      }, debouncedRefresh)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'payments'
      }, debouncedRefresh)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'booking_vehicles'
      }, debouncedRefresh)
      .subscribe();

    channelRef.current = channel;

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, [refresh, debouncedRefresh, customerId]);

  // Derived data — unified state mapping
  const activeBooking = bookings.find(b => ['in_progress'].includes(b.status?.toLowerCase())) || bookings.find(b => b.status?.toLowerCase() === 'scheduled');
  const upcomingBookings = bookings.filter(b => ['scheduled', 'confirmed'].includes(b.status?.toLowerCase()));
  const pastBookings = bookings.filter(b => ['completed', 'cancelled'].includes(b.status?.toLowerCase()));

  return { bookings, allBookings: bookings, activeBooking, upcomingBookings, pastBookings, loading, refresh };
};
