import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';

const ChatContext = createContext(null);

export const ChatProvider = ({ children }) => {
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [activeBookingId, setActiveBookingId] = useState(null);
  const [globalUnreadCount, setGlobalUnreadCount] = useState(0);
  // Per-thread counters: { [bookingId]: unreadCount }. A single global number
  // could not tell a user WHICH booking was waiting on them once more than one
  // conversation existed.
  const [threadUnread, setThreadUnread] = useState({});

  const refreshUnreadCount = useCallback(async () => {
    if (!user?.id) {
      setGlobalUnreadCount(0);
      setThreadUnread({});
      return;
    }

    // Pull the unread rows grouped per booking so one round trip feeds both the
    // global launcher badge and every per-thread counter. Rows the user already
    // has open are excluded from the badge but still counted on their thread.
    const { data, error } = await supabase
      .from('booking_messages')
      .select('id, booking_id')
      .neq('message_type', 'system')
      .eq('is_read', false)
      .neq('sender_id', user.id);

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
    if (!user?.id) {
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
      }, (payload) => {
        if (payload.new.message_type === 'system') return;
        if (payload.new.sender_id === user.id || payload.new.is_read) return;
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
  }, [user?.id, activeBookingId, refreshUnreadCount]);

  const openChatForBooking = (bookingId) => {
    if (!bookingId) return;
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
