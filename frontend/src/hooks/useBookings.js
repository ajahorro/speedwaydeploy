import { useMemo } from 'react';
import { useUnifiedData } from '../context/UnifiedContext';
import { calculatePaymentStatus } from '../utils/paymentUtils';

/**
 * useBookings hook.
 *
 * The signed-in customer's bookings are loaded and kept live exactly once, by
 * UnifiedProvider (one fetch, one set of realtime channels, coalesced refresh).
 * This hook only projects that shared list, so opening a screen no longer starts
 * a second fetch and a second set of subscriptions for the same data.
 * Returns: { bookings, activeBooking, upcomingBookings, pastBookings, loading, refresh }
 */
export const useBookings = () => {
  const { bookings: sharedBookings, isLoading, refreshData } = useUnifiedData();

  const bookings = useMemo(
    () => (Array.isArray(sharedBookings) ? sharedBookings : []).map((b) => ({
      ...b,
      // Each booking carries its ledger; status is derived from it.
      paymentStatus: calculatePaymentStatus(b)
    })),
    [sharedBookings]
  );

  const activeBooking = bookings.find(b => ['in_progress'].includes(b.status?.toLowerCase())) || bookings.find(b => b.status?.toLowerCase() === 'scheduled');
  const upcomingBookings = bookings.filter(b => ['scheduled', 'confirmed'].includes(b.status?.toLowerCase()));
  const pastBookings = bookings.filter(b => ['completed', 'cancelled'].includes(b.status?.toLowerCase()));

  return { bookings, allBookings: bookings, activeBooking, upcomingBookings, pastBookings, loading: isLoading, refresh: refreshData };
};
