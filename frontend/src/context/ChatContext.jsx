import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase, createUniqueChannel } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';

const ChatContext = createContext(null);

export const ChatProvider = ({ children }) => {
  const { user, profile } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const role = String(profile?.role || '').toUpperCase();
  const chatAccessAllowed = Boolean(user?.id && profile?.is_active !== false && ['ADMIN', 'CUSTOMER'].includes(role));

  // ── Section 2: ONE CUSTOMER = ONE CHAT ────────────────────────────────────
  //
  // A conversation is now owned by a CUSTOMER, not a booking: a customer who
  // books five times has ONE continuous thread instead of five fragmented ones.
  //
  // `booking_messages.customer_id` is denormalized onto every message (see the
  // Item 2 migration) so this thread can be queried and subscribed to directly,
  // without joining through bookings on every message.
  //
  // `activeBookingId` is retained as the "booking currently in view" so a message
  // can be TAGGED with the booking it relates to; it no longer identifies the
  // thread. `activeCustomerId` is the thread identity and the unread key.
  const [activeCustomerId, setActiveCustomerId] = useState(null);
  const [activeBookingId, setActiveBookingId] = useState(null);
  const [globalUnreadCount, setGlobalUnreadCount] = useState(0);
  // Per-thread counters: { [customerId]: unreadCount }. A single global number
  // could not tell a user WHICH conversation was waiting on them once more than
  // one conversation existed.
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
    if (!chatAccessAllowed) {
      setGlobalUnreadCount(0);
      setThreadUnread({});
      return;
    }

    // Pull unread rows grouped PER CUSTOMER so one round trip feeds both the
    // global launcher badge and every per-thread counter. Rows the user already
    // has open are excluded from the badge but still counted on their thread.
    //
    // Messages with a null customer_id (legacy rows the migration could not map,
    // or accountless walk-ins whose booking has no customer) can never belong to
    // a real thread: booking_messages.sender_id is NOT NULL FK -> profiles, so
    // there is no customer to converse with. They are excluded from every badge.
    const { data, error } = await supabase
      .from('booking_messages')
      .select('id, customer_id')
      .neq('message_type', 'system')
      .eq('is_read', false)
      .neq('sender_id', user.id)
      .not('customer_id', 'is', null);

    if (error) return;

    const perThread = {};
    let visibleCount = 0;
    (data || []).forEach(row => {
      const key = row.customer_id;
      perThread[key] = (perThread[key] || 0) + 1;
      if (key !== activeCustomerId) visibleCount += 1;
    });

    setThreadUnread(perThread);
    setGlobalUnreadCount(visibleCount);
  }, [user?.id, activeCustomerId, chatAccessAllowed]);

  /**
   * Called by an open chat panel so the thread the user is literally reading
   * never keeps a stale badge, and so the launcher can show per-thread counts
   * for conversations that are not currently mounted.
   *
   * The key is now a CUSTOMER id (the thread), not a booking id.
   */
  const reportThreadUnread = useCallback((customerId, count) => {
    if (!customerId) return;
    setThreadUnread(previous => ({ ...previous, [customerId]: Math.max(0, Number(count) || 0) }));
  }, []);

  useEffect(() => {
    // Scenario 6: a revoked account must never hold a realtime socket open.
    if (!chatAccessAllowed || accountRevoked) {
      setGlobalUnreadCount(0);
      setThreadUnread({});
      setActiveCustomerId(null);
      setActiveBookingId(null);
      setIsOpen(false);
      return undefined;
    }

    refreshUnreadCount();

    const channel = createUniqueChannel(`global-chat-unread-${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'booking_messages'
      }, async (payload) => {
        if (payload.new.message_type === 'system') return;
        if (payload.new.sender_id === user.id || payload.new.is_read) return;
        // Section 2: the customer id is denormalized onto the message itself, so
        // no bookings join is needed to decide which thread this belongs to. Rows
        // predating the migration fall back to a lookup through the booking.
        let arrivedFor = payload.new.customer_id;
        if (!arrivedFor && payload.new.booking_id) {
          const { data: booking } = await supabase
            .from('bookings')
            .select('customer_id')
            .eq('id', payload.new.booking_id)
            .maybeSingle();
          arrivedFor = booking?.customer_id;
        }
        if (!arrivedFor) return;
        // Always credit the owning thread; only add to the global badge when the
        // user is not already looking at that conversation.
        setThreadUnread(previous => ({ ...previous, [arrivedFor]: (previous[arrivedFor] || 0) + 1 }));
        if (arrivedFor !== activeCustomerId) setGlobalUnreadCount(previous => previous + 1);
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
  }, [user?.id, activeCustomerId, refreshUnreadCount, accountRevoked, chatAccessAllowed]);

  /**
   * Open the conversation for a BOOKING. Section 2: the booking is resolved to
   * its owning CUSTOMER, and that customer's single thread is opened. The booking
   * is still remembered so new messages default to tagging it.
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

  /**
   * Section 2: open a customer's thread directly (no booking context). Used by
   * the admin chat launcher, which lists one entry per customer.
   */
  const openChatForCustomer = (customerId) => {
    if (!customerId || accountRevoked || !chatAccessAllowed) return;
    setActiveCustomerId(customerId);
    setActiveBookingId(null);
    setIsOpen(true);
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
      hasUnreadInThread,
      setGlobalUnreadCount,
      refreshUnreadCount,
      reportThreadUnread,
      setActiveCustomerId,
      setActiveBookingId,
      openChatForBooking,
      openChatForCustomer,
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
