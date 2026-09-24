import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { fetchCustomerBookings, subscribeToCustomerBookings } from '../services/bookingService';
import { fetchNotifications, subscribeToNotifications } from '../services/notificationService';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';

const UnifiedContext = createContext();

export const UnifiedProvider = ({ children }) => {
    const { user } = useAuth();

    const [bookings, setBookings] = useState([]);
    const [notifications, setNotifications] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    // Define loadData using useCallback so it can be safely called from anywhere
    const loadData = useCallback(async () => {
        if (!user) return;
        try {
            const [bookingsData, notificationsData] = await Promise.all([
                fetchCustomerBookings(user.id),
                fetchNotifications(user.id)
            ]);
            setBookings(bookingsData);
            setNotifications(notificationsData);
        } catch (error) {
            console.error('Failed to fetch global data:', error);
        } finally {
            setIsLoading(false);
        }
    }, [user]);

    useEffect(() => {
        if (!user) {
            setBookings([]);
            setNotifications([]);
            setIsLoading(false);
            return;
        }

        loadData();

        // Real-Time Listeners
        const bookingSub = subscribeToCustomerBookings(user.id, () => {
            fetchCustomerBookings(user.id).then(setBookings);
        });

        // Booking status is also represented by child vehicle and payment rows.
        // Subscribe to those tables as well so list/dashboard projections do not
        // wait for a master-row update or a manual refresh.
        const childStateSub = supabase
            .channel(`customer-booking-state-${user.id}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_vehicles' }, () => loadData())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, () => loadData())
            .subscribe();

        const notificationSub = subscribeToNotifications(user.id, () => {
            fetchNotifications(user.id).then(setNotifications);
        });

        return () => {
            if (bookingSub) bookingSub.unsubscribe();
            if (childStateSub) supabase.removeChannel(childStateSub);
            if (notificationSub) notificationSub.unsubscribe();
        };
    }, [user, loadData]);

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