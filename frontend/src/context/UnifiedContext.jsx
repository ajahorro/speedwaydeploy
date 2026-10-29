import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { fetchCustomerBookings, subscribeToCustomerBookings } from '../services/bookingService';
import { fetchNotifications, subscribeToNotifications } from '../services/notificationService';
import { useAuth } from '../hooks/useAuth';
import { subscribeTables } from '../lib/realtimeHub';
import { createCoalescer } from '../lib/coalesce';

const UnifiedContext = createContext();

export const UnifiedProvider = ({ children }) => {
    const { user, profile } = useAuth();
    // Bookings and notifications here are the customer's own. Admin and staff screens
    // load their own data on-demand only when their respective pages are looked at.
    // Eagerly fetching it (and listening to every change) for them was pure overhead on every page.
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
                isCustomer ? fetchNotifications(user.id) : Promise.resolve([])
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
    const refreshBookings = useCallback(() => {
        if (!isCustomer) return;
        fetchCustomerBookings(user.id)
            .then((data) => setBookings(Array.isArray(data) ? data : []))
            .catch((error) => console.error('[UnifiedContext] Booking refresh failed:', error));
    }, [user, isCustomer]);

    useEffect(() => {
        if (!user) {
            setBookings([]);
            setNotifications([]);
            setIsLoading(false);
            return;
        }

        loadData();

        // Real-Time Listeners. Only active for customer portal.
        const scheduleBookingRefresh = createCoalescer(refreshBookings);
        const bookingSub = isCustomer ? subscribeToCustomerBookings(user.id, scheduleBookingRefresh) : null;

        const stopChildState = isCustomer
            ? subscribeTables([{ table: 'booking_vehicles' }, { table: 'payments' }], scheduleBookingRefresh)
            : null;

        const notificationSub = isCustomer ? subscribeToNotifications(user.id, () => {
            fetchNotifications(user.id)
                .then((data) => setNotifications(Array.isArray(data) ? data : []))
                .catch((error) => console.error('[UnifiedContext] Notification refresh failed:', error));
        }) : null;

        return () => {
            scheduleBookingRefresh.cancel();
            if (bookingSub) bookingSub.unsubscribe();
            if (stopChildState) stopChildState();
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
