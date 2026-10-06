import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { subscribeTables } from '../lib/realtimeHub';
import { logger } from '../utils/logger';
import { calculatePaymentStatus } from '../utils/paymentUtils';
import { fetchBookingLedgers } from '../services/ledgerService';
import toast from '@/lib/toast';

/**
 * useAdminBookings — REQ-NFR-05
 * Custom hook for admin booking data with Supabase Realtime.
 * Replaces inline fetch + useEffect in AdminBookings.jsx.
 * Loads the most recent PAGE_SIZE bookings first (the directory used to download
 * every booking with every nested row). `loadAll()` fetches the rest; the page calls
 * it when a search or filter needs the complete set.
 * Returns: { bookings, loading, refresh, hasMore, loadAll }
 */
const PAGE_SIZE = 150;

export const useAdminBookings = () => {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const fetchAllRef = useRef(false);
  const debounceRef = useRef(null);

  const loadedOnce = useRef(false);

  const refresh = useCallback(async () => {
    // Only the first load shows the loading state; live refreshes swap data in
    // place instead of flashing the whole list back to a skeleton.
    if (!loadedOnce.current) setLoading(true);
    try {
      logger.admin('Syncing Live Booking Directory...');

      const { data, error } = await supabase
        .from('bookings')
        .select(`
          *,
          customer:profiles!bookings_customer_id_fkey(full_name, email),
          vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services!booking_vehicle_id(service_name)),
          payments:payments!payments_booking_id_fkey(id, status)
        `)
        .order('created_at', { ascending: false })
        .range(0, fetchAllRef.current ? 9999 : PAGE_SIZE);

      if (error) throw error;
      // One extra row is requested so we know whether older bookings exist.
      const more = !fetchAllRef.current && (data || []).length > PAGE_SIZE;
      if (more) data.pop();
      setHasMore(more);

      // Payment status from the database ledger, fetched once for all bookings.
      const ledgers = await fetchBookingLedgers((data || []).map(b => b.id));

      // DEDUPLICATION ENGINE: Resolve Cartesian Product from nested joins
      const uniqueMap = new Map();
      (data || []).forEach(b => {
        if (!uniqueMap.has(b.id)) {
          const withLedger = { ...b, ledger: ledgers.get(b.id) || null };
          uniqueMap.set(b.id, {
            ...withLedger,
            calculatedPaymentStatus: calculatePaymentStatus(withLedger)
          });
        }
      });

      setBookings(Array.from(uniqueMap.values()));
      loadedOnce.current = true;
      logger.admin('Booking Directory synchronized.');
    } catch (err) {
      logger.error('Booking Fetch Error', err);
      toast.error('Failed to sync booking records.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced refresh — prevents rapid-fire re-fetches from multiple real-time events
  const debouncedRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      refresh();
    }, 300);
  }, [refresh]);

  useEffect(() => {
    refresh();

    // Multi-table Supabase Realtime subscription
    const stopRealtime = subscribeTables(
      [{ table: 'bookings' }, { table: 'payments' }, { table: 'booking_vehicles' }],
      debouncedRefresh
    );

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      stopRealtime();
    };
  }, [refresh, debouncedRefresh]);

  const loadAll = useCallback(() => {
    if (fetchAllRef.current) return;
    fetchAllRef.current = true;
    refresh();
  }, [refresh]);

  return { bookings, loading, refresh, hasMore, loadAll };
};
