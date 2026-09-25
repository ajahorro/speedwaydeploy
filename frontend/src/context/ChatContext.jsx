import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';

const ChatContext = createContext(null);

export const ChatProvider = ({ children }) => {
  const { user, profile } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [activeBookingId, setActiveBookingId] = useState(null);
  const [globalUnreadCount, setGlobalUnreadCount] = useState(0);
  // Per-thread counters: { [bookingId]: unreadCount }. A single global number
  // could not tell a user WHICH booking was waiting on them once more than one
  // conversation existed.
  const [threadUnread, setThreadUnread] = useState({});

  // 🛡️ SCENARIO 6 — CHAT DEEP LINK DURING ACCOUNT REVOCATION.
  //
  // A customer opens the chat via an email deep link (?chat=open) and, mid-
  // conversation, an admin bans/deletes their account. The auth JWT is NOT
  // revoked by an is_active flip, so `onAuthStateChange` may never fire — the
  // chat widget stayed MOUNTED with a live realtime socket and kept trying to
  // read/write, each attempt rejected by RLS, producing an endless console
  // error loop while the user stared at a dead panel.
  //
  // The single source of revocation truth is the profile row. When it reports
  // the account is gone (profile === null while a user exists) or inactive
  // (is_active === false), we tear the whole chat down: close the panel, drop
  // the active thread, clear counters, and (below) the effect early-returns so
  // no channel is ever created again. The route guard in the app shell then
  // redirects to the landing page.
  const accountRevoked = Boolean(user?.id) && (profile === null || profile?.is_active === false);

  const refreshUnreadCount = useCallback(async () => {
    if (!user?.id) {
      setGlobalUnreadCount(0);
      setThreadUnread({});
      return;
    }

    // Pull the unread rows grouped per booking so one round trip feeds both the
    // global launcher badge and every per-thread counter. Rows the user already
    // has open are excluded from the badge but still counted on their thread.
    //
    // Guests / accountless walk-ins (bookings.customer_id is null) can never have
    // a real conversation: booking_messages.sender_id is NOT NULL FK -> profiles,
    // so there is no customer profile to send from and no receiver. Their threads
    // are therefore excluded from every badge/list — chat only exists once the
    // walk-in is linked to a registered account.
    const { data, error } = await supabase
      .from('booking_messages')
      .select('id, booking_id, booking:bookings!inner(customer_id)')
      .neq('message_type', 'system')
      .eq('is_read', false)
      .neq('sender_id', user.id)
      .not('booking.customer_id', 'is', null);

    if (error) return;

    const perThread = {};
    let visibleCount = 0;
    (data || []).forEach(row => {
      perThread[row.booking_id] = (perThread[row.booking_id] || 0) + 1;
      if (row.booking_id !== activeBookingId) visibleCount += 1;
    });

    setThreadUnread(perThread);
    setGlobalUnreadCount(visibleCount);
  }, [user?.id, activeBookingId]);

  /**
   * Called by an open chat panel so the thread the user is literally reading
   * never keeps a stale badge, and so the launcher can show per-thread counts
   * for conversations that are not currently mounted.
   */
  const reportThreadUnread = useCallback((bookingId, count) => {
    if (!bookingId) return;
    setThreadUnread(previous => ({ ...previous, [bookingId]: Math.max(0, Number(count) || 0) }));
  }, []);

  useEffect(() => {
    // Scenario 6: a revoked account must never hold a realtime socket open.
    if (!user?.id || accountRevoked) {
      setGlobalUnreadCount(0);
      setThreadUnread({});
      setActiveBookingId(null);
      setIsOpen(false);
      return undefined;
    }

    refreshUnreadCount();

    const channel = supabase
      .channel(`global-chat-unread-${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'booking_messages'
      }, async (payload) => {
        if (payload.new.message_type === 'system') return;
        if (payload.new.sender_id === user.id || payload.new.is_read) return;
        const { data: booking } = await supabase
          .from('bookings')
          .select('customer_id')
          .eq('id', payload.new.booking_id)
          .maybeSingle();
        if (!booking?.customer_id) return;
        const arrivedFor = payload.new.booking_id;
        // Always credit the owning thread; only add to the global badge when the
        // user is not already looking at that conversation.
        setThreadUnread(previous => ({ ...previous, [arrivedFor]: (previous[arrivedFor] || 0) + 1 }));
        if (arrivedFor !== activeBookingId) setGlobalUnreadCount(previous => previous + 1);
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'booking_messages'
      }, (payload) => {
        if (payload.new.is_read) refreshUnreadCount();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, activeBookingId, refreshUnreadCount, accountRevoked]);

  const openChatForBooking = async (bookingId) => {
    if (!bookingId || accountRevoked) return;
    const { data: booking } = await supabase
      .from('bookings')
      .select('customer_id')
      .eq('id', bookingId)
      .maybeSingle();
    if (!booking?.customer_id) return;
    setActiveBookingId(bookingId);
    setIsOpen(true);
  };

  const closeChat = () => {
    setIsOpen(false);
    refreshUnreadCount();
  };

  /** True when a given booking still has messages the user has not opened. */
  const hasUnreadInThread = useCallback((bookingId) => Boolean(threadUnread[bookingId]), [threadUnread]);

  return (
    <ChatContext.Provider value={{
      isOpen,
      activeBookingId,
      globalUnreadCount,
      threadUnread,
      hasUnreadInThread,
      setGlobalUnreadCount,
      refreshUnreadCount,
      reportThreadUnread,
      setActiveBookingId,
      openChatForBooking,
      closeChat
    }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useGlobalChat = () => {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useGlobalChat must be used within a ChatProvider');
  return context;
};
