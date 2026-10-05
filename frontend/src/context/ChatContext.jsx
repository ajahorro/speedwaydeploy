import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { subscribeTable } from '../lib/realtimeHub';
import { createCoalescer } from '../lib/coalesce';
import { useAuth } from '../hooks/useAuth';

const ChatContext = createContext(null);

export const ChatProvider = ({ children }) => {
  const { user, profile } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const role = String(profile?.role || '').toUpperCase();
  const isAdmin = role === 'ADMIN';
  const chatAccessAllowed = Boolean(user?.id && profile?.is_active !== false && ['ADMIN', 'CUSTOMER'].includes(role));

  // ── ONE CUSTOMER = ONE CHAT ───────────────────────────────────────────────
  //
  // A conversation is owned by a CUSTOMER, not a booking: a customer who books
  // five times has ONE continuous thread. `booking_messages.customer_id` is
  // denormalized onto every message so the thread can be queried and subscribed
  // to directly. A message may carry a booking TAG (booking_id), like a ticket
  // reference.
  //
  // Every chat surface — the floating bubble, the inline booking chat, and the
  // admin Chat page — reads from this one context (thread list, unread counts,
  // active thread). The floating bubble is only a shortcut that opens the same
  // thread; it has no data of its own.
  const [activeCustomerId, setActiveCustomerId] = useState(null);
  const [activeBookingId, setActiveBookingId] = useState(null);
  // Per-thread unread counters: { [customerId]: unreadCount }.
  const [threadUnread, setThreadUnread] = useState({});
  // Admin only: every conversation, newest first (admin_chat_threads()).
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(false);

  // 🛡️ Account revocation: when the profile reports the account is gone or
  // inactive, tear the chat down so no realtime listener is ever created.
  const accountRevoked = Boolean(user?.id) && (profile === null || profile?.is_active === false);

  // The badge on the launcher counts every thread except the one being read.
  const globalUnreadCount = useMemo(
    () => Object.entries(threadUnread).reduce((sum, [customerId, count]) => (
      isOpen && customerId === activeCustomerId ? sum : sum + (Number(count) || 0)
    ), 0),
    [threadUnread, isOpen, activeCustomerId]
  );

  const refreshUnreadCount = useCallback(async () => {
    if (!chatAccessAllowed) {
      setThreadUnread({});
      return;
    }

    // Unread rows grouped PER CUSTOMER feed both the launcher badge and every
    // per-thread counter. Rows with a null customer_id (legacy, unmappable) can
    // never belong to a real thread and are excluded.
    const { data, error } = await supabase
      .from('booking_messages')
      .select('id, customer_id')
      .neq('message_type', 'system')
      .eq('is_read', false)
      .neq('sender_id', user.id)
      .not('customer_id', 'is', null);

    if (error) return;

    const perThread = {};
    (data || []).forEach((row) => {
      perThread[row.customer_id] = (perThread[row.customer_id] || 0) + 1;
    });
    setThreadUnread(perThread);
  }, [user?.id, chatAccessAllowed]);

  const refreshThreads = useCallback(async () => {
    if (!chatAccessAllowed || !isAdmin) {
      setThreads([]);
      return;
    }
    setThreadsLoading(true);
    const { data, error } = await supabase.rpc('admin_chat_threads');
    if (!error) setThreads(Array.isArray(data) ? data : []);
    setThreadsLoading(false);
  }, [chatAccessAllowed, isAdmin]);

  /**
   * Called by an open chat panel so the thread the user is literally reading
   * never keeps a stale badge. The key is a CUSTOMER id (the thread).
   */
  const reportThreadUnread = useCallback((customerId, count) => {
    if (!customerId) return;
    setThreadUnread(previous => ({ ...previous, [customerId]: Math.max(0, Number(count) || 0) }));
  }, []);

  // Kept in refs so the realtime listener below can stay subscribed while the
  // user opens and closes threads (it used to be torn down and rebuilt each time).
  const refreshUnreadRef = useRef(refreshUnreadCount);
  const refreshThreadsRef = useRef(refreshThreads);
  refreshUnreadRef.current = refreshUnreadCount;
  refreshThreadsRef.current = refreshThreads;

  useEffect(() => {
    if (!chatAccessAllowed || accountRevoked) {
      setThreadUnread({});
      setThreads([]);
      setActiveCustomerId(null);
      setActiveBookingId(null);
      setIsOpen(false);
      return undefined;
    }

    refreshUnreadRef.current();
    refreshThreadsRef.current();

    // A burst of events (message + read receipts) becomes one refetch.
    const scheduleThreads = createCoalescer(() => refreshThreadsRef.current(), 400);
    const scheduleUnread = createCoalescer(() => refreshUnreadRef.current(), 400);

    const stopInsert = subscribeTable({ table: 'booking_messages', event: 'INSERT' }, async (payload) => {
      // Events may have been missed (hidden tab, back/forward cache): reload.
      if (payload?.resync) {
        scheduleUnread();
        scheduleThreads();
        return;
      }
      const row = payload?.new;
      if (!row || row.message_type === 'system') return;
      scheduleThreads();
      if (row.sender_id === user.id || row.is_read) return;
      // The customer id is on the message itself; rows predating that column
      // fall back to a lookup through the booking.
      let arrivedFor = row.customer_id;
      if (!arrivedFor && row.booking_id) {
        const { data: booking } = await supabase
          .from('bookings')
          .select('customer_id')
          .eq('id', row.booking_id)
          .maybeSingle();
        arrivedFor = booking?.customer_id;
      }
      if (!arrivedFor) return;
      setThreadUnread(previous => ({ ...previous, [arrivedFor]: (previous[arrivedFor] || 0) + 1 }));
    });

    const stopUpdate = subscribeTable({ table: 'booking_messages', event: 'UPDATE' }, (payload) => {
      if (payload?.resync || payload?.new?.is_read) {
        scheduleUnread();
        scheduleThreads();
      }
    });

    return () => {
      scheduleThreads.cancel();
      scheduleUnread.cancel();
      stopInsert();
      stopUpdate();
    };
  }, [user?.id, accountRevoked, chatAccessAllowed]);

  /**
   * Open the conversation for a BOOKING: the booking is resolved to its owning
   * CUSTOMER and that customer's single thread is opened. The booking is kept as
   * the default tag for new messages.
   */
  const openChatForBooking = async (bookingId) => {
    if (!bookingId || accountRevoked || !chatAccessAllowed) return;
    const { data: booking } = await supabase
      .from('bookings')
      .select('customer_id')
      .eq('id', bookingId)
      .maybeSingle();
    if (!booking?.customer_id) return;
    setActiveCustomerId(booking.customer_id);
    setActiveBookingId(bookingId);
    setIsOpen(true);
  };

  /** Open a customer's thread directly (no booking context): the admin inbox and bubble list. */
  const openChatForCustomer = (customerId, bookingId = null) => {
    if (!customerId || accountRevoked || !chatAccessAllowed) return;
    setActiveCustomerId(customerId);
    setActiveBookingId(bookingId);
    setIsOpen(true);
  };

  /** Admin: open the conversation list (no thread chosen yet). */
  const openInbox = () => {
    if (accountRevoked || !chatAccessAllowed) return;
    setActiveCustomerId(null);
    setActiveBookingId(null);
    setIsOpen(true);
    refreshThreads();
  };

  /** Leave the open thread and go back to the list. */
  const backToInbox = () => {
    setActiveCustomerId(null);
    setActiveBookingId(null);
    refreshThreads();
  };

  const closeChat = () => {
    setIsOpen(false);
    refreshUnreadCount();
  };

  /** True when a given CUSTOMER thread still has messages the user has not opened. */
  const hasUnreadInThread = useCallback((customerId) => Boolean(threadUnread[customerId]), [threadUnread]);

  return (
    <ChatContext.Provider value={{
      isOpen,
      activeCustomerId,
      activeBookingId,
      globalUnreadCount,
      threadUnread,
      threads,
      threadsLoading,
      hasUnreadInThread,
      refreshUnreadCount,
      refreshThreads,
      reportThreadUnread,
      setActiveCustomerId,
      setActiveBookingId,
      openChatForBooking,
      openChatForCustomer,
      openInbox,
      backToInbox,
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
