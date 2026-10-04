import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { fetchCustomerBookings, subscribeToCustomerBookings } from '../services/bookingService';
import { fetchNotifications, subscribeToNotifications } from '../services/notificationService';
import { useAuth } from '../hooks/useAuth';
import { supabase, createUniqueChannel } from '../lib/supabase';
import { createCoalescer } from '../lib/coalesce';

const UnifiedContext = createContext();

export const UnifiedProvider = ({ children }) => {
    const { user, profile } = useAuth();
    // Bookings here are the customer's own. Admin and staff screens load their own
    // data, so fetching it (and listening to every booking change) for them was
    // pure overhead on every page.
    const isCustomer = String(profile?.role || '').toUpperCase() === 'CUSTOMER';

    const [bookings, setBookings] = useState([]);
    const [notifications, setNotifications] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    // Define loadData using useCallback so it can be safely called from anywhere
    const loadData = useCallback(async () => {
        if (!user) return;
        try {
            const [bookingsData, notificationsData] = await Promise.all([
                isCustomer ? fetchCustomerBookings(user.id) : Promise.resolve([]),
                fetchNotifications(user.id)
            ]);
            setBookings(bookingsData);
            setNotifications(notificationsData);
        } catch (error) {
            console.error('Failed to fetch global data:', error);
        } finally {
            setIsLoading(false);
        }
    }, [user, isCustomer]);

    // Refresh the booking list without letting a failure escape.
    //
    // `fetchCustomerBookings` THROWS on a request error, and this runs from a
    // realtime callback: the rejection had no `.catch`, so it escaped the promise
    // chain and was caught by the global error boundary — which unmounted the
    // entire screen ("allBookings.filter is not a function") and marked the
    // context's array as undefined for every consumer. A failed refresh must
    // leave the previous list on screen, not take the app down with it.
    const refreshBookings = useCallback(() => {
        fetchCustomerBookings(user.id)
            .then((data) => setBookings(Array.isArray(data) ? data : []))
            .catch((error) => console.error('[UnifiedContext] Booking refresh failed:', error));
    }, [user]);

    useEffect(() => {
        if (!user) {
            setBookings([]);
            setNotifications([]);
            setIsLoading(false);
            return;
        }

        loadData();

        // Real-Time Listeners. Every burst of events becomes one refetch.
        const scheduleBookingRefresh = createCoalescer(refreshBookings);
        const bookingSub = isCustomer ? subscribeToCustomerBookings(user.id, scheduleBookingRefresh) : null;

        // Booking status is also represented by child vehicle and payment rows.
        // Subscribe to those tables as well so list/dashboard projections do not
        // wait for a master-row update or a manual refresh.
        const childStateSub = isCustomer
            ? createUniqueChannel(`customer-booking-state-${user.id}`)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_vehicles' }, scheduleBookingRefresh)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, scheduleBookingRefresh)
                .subscribe()
            : null;

        const notificationSub = subscribeToNotifications(user.id, () => {
            fetchNotifications(user.id)
                .then((data) => setNotifications(Array.isArray(data) ? data : []))
                .catch((error) => console.error('[UnifiedContext] Notification refresh failed:', error));
        });

        return () => {
            scheduleBookingRefresh.cancel();
            if (bookingSub) bookingSub.unsubscribe();
            if (childStateSub) supabase.removeChannel(childStateSub);
            if (notificationSub) notificationSub.unsubscribe();
        };
    }, [user, isCustomer, loadData, refreshBookings]);

    const unreadCount = notifications.filter(n => !n.is_read).length;

    return (
        <UnifiedContext.Provider value={{
            bookings,
            notifications,
            unreadCount,
            isLoading,
            refreshData: loadData // <-- Exposed here so components can call it!
        }}>
            {children}
        </UnifiedContext.Provider>
    );
};

export const useUnifiedData = () => useContext(UnifiedContext);