import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle, X, ChevronLeft } from 'lucide-react';
import { useGlobalChat } from '../context/ChatContext';
import { useAuth } from '../hooks/useAuth';
import BookingChat from './BookingChat';

const BUBBLE = 58;        // bubble diameter in px
const EDGE = 8;           // the bubble always keeps this gap from every screen edge
const DEFAULT_GAP = 20;   // first position: bottom-right, like before
const POSITION_KEY = 'comar-chat-bubble-position';

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

// Position is stored as a fraction (0..1) of the free area, so it survives window
// resizes and rotation and can never end up outside the screen.
const readStoredPosition = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
    if (parsed && Number.isFinite(parsed.fx) && Number.isFinite(parsed.fy)) {
      return { fx: clamp(parsed.fx, 0, 1), fy: clamp(parsed.fy, 0, 1) };
    }
  } catch { /* storage unavailable */ }
  return null;
};

const defaultPosition = (vw, vh) => ({
  fx: (vw - BUBBLE - DEFAULT_GAP - EDGE) / Math.max(1, vw - BUBBLE - 2 * EDGE),
  fy: (vh - BUBBLE - DEFAULT_GAP - EDGE) / Math.max(1, vh - BUBBLE - 2 * EDGE)
});

const toPixels = (pos, vw, vh) => ({
  x: EDGE + clamp(pos.fx, 0, 1) * Math.max(0, vw - BUBBLE - 2 * EDGE),
  y: EDGE + clamp(pos.fy, 0, 1) * Math.max(0, vh - BUBBLE - 2 * EDGE)
});

const FloatingBubbleChat = () => {
  const {
    isOpen,
    activeCustomerId,
    activeBookingId,
    globalUnreadCount,
    threadUnread,
    closeChat,
    openChatForBooking,
    openChatForCustomer,
    openInbox,
    backToInbox,
    threads,
    threadsLoading
  } = useGlobalChat();
  const { user, profile } = useAuth();
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [position, setPosition] = useState(() => readStoredPosition() || defaultPosition(window.innerWidth, window.innerHeight));
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ pointerId: null, startX: 0, startY: 0, originX: 0, originY: 0, moved: false });
  const positionRef = useRef(position);
  positionRef.current = position;
  const chatRef = useRef(null);
  const bubbleRef = useRef(null);
  const closeTimerRef = useRef(null);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDownOutside = (event) => {
      const clickedInsideChat = chatRef.current?.contains(event.target);
      const clickedBubble = bubbleRef.current?.contains(event.target);

      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }

      if (!clickedInsideChat && !clickedBubble) {
        closeTimerRef.current = setTimeout(() => {
          closeChat();
        }, 120);
      }
    };

    document.addEventListener('mousedown', handlePointerDownOutside);
    return () => {
      document.removeEventListener('mousedown', handlePointerDownOutside);
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, [isOpen, closeChat]);

  if (!user?.id) return null;
  if (!['ADMIN', 'CUSTOMER'].includes(String(profile?.role || '').toUpperCase()) || profile?.is_active === false) return null;

  // Section 2: a "thread" is a CUSTOMER, so unread keys are customer ids — not
  // booking ids. `activeBookingId` only supplies the tag context once a thread is
  // open, which is why the panel is keyed on activeCustomerId below.
  const unreadCustomerIds = Object.keys(threadUnread || {}).filter(threadId => threadUnread[threadId] > 0);

  const handlePointerDown = (event) => {
    const origin = toPixels(positionRef.current, window.innerWidth, window.innerHeight);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      moved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  };

  const handlePointerMove = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - dragRef.current.startX) > 5 || Math.abs(event.clientY - dragRef.current.startY) > 5) {
      dragRef.current.moved = true;
    }
    if (!dragRef.current.moved) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = clamp(dragRef.current.originX + event.clientX - dragRef.current.startX, EDGE, vw - BUBBLE - EDGE);
    const y = clamp(dragRef.current.originY + event.clientY - dragRef.current.startY, EDGE, vh - BUBBLE - EDGE);
    setPosition({
      fx: (x - EDGE) / Math.max(1, vw - BUBBLE - 2 * EDGE),
      fy: (y - EDGE) / Math.max(1, vh - BUBBLE - 2 * EDGE)
    });
  };

  const handlePointerUp = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDragging(false);

    if (dragRef.current.moved) {
      try { localStorage.setItem(POSITION_KEY, JSON.stringify(positionRef.current)); } catch { /* storage unavailable */ }
    }

    if (!dragRef.current.moved) {
      if (isOpen) {
        closeChat();
      } else if (activeBookingId) {
        openChatForBooking(activeBookingId);
      } else if (activeCustomerId) {
        openChatForCustomer(activeCustomerId);
      } else if (String(profile?.role || '').toUpperCase() === 'CUSTOMER') {
        openChatForCustomer(user.id);
      } else if (String(profile?.role || '').toUpperCase() === 'ADMIN') {
        openInbox();
      }
    }

    dragRef.current.pointerId = null;
  };

  const bubble = toPixels(position, viewport.w, viewport.h);
  const isAdminRole = String(profile?.role || '').toUpperCase() === 'ADMIN';

  // The open panel sits on whichever side of the bubble has room, and never
  // leaves the screen: above if there is space, otherwise below; aligned to the
  // bubble's right edge on the right half of the screen, left edge on the left.
  const placePanel = (width, height) => {
    const w = Math.min(width, viewport.w - 2 * EDGE);
    const h = Math.min(height, viewport.h - 2 * EDGE);
    const roomAbove = bubble.y - 12 - EDGE;
    const roomBelow = viewport.h - (bubble.y + BUBBLE + 12) - EDGE;
    const above = roomAbove >= h || roomAbove >= roomBelow;
    const top = above ? Math.max(EDGE, bubble.y - 12 - h) : Math.min(viewport.h - EDGE - h, bubble.y + BUBBLE + 12);
    const onRightHalf = bubble.x + BUBBLE / 2 > viewport.w / 2;
    const left = clamp(onRightHalf ? bubble.x + BUBBLE - w : bubble.x, EDGE, viewport.w - EDGE - w);
    return { position: 'fixed', top, left, width: w, height: h, zIndex: 9999 };
  };

  const chatWidth = Math.min(420, Math.max(300, viewport.w * 0.9));
  const chatHeight = Math.min(620, Math.max(400, viewport.h * 0.78));
  const hintWidth = Math.min(360, Math.max(280, viewport.w * 0.85));

  return (
    <>
      {isOpen && activeCustomerId && (
        <div ref={chatRef} style={{ ...placePanel(chatWidth, chatHeight), background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', boxShadow: '0 20px 50px rgba(0,0,0,0.25)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)' }}>
            {isAdminRole && (
              <button onClick={backToInbox} aria-label="All conversations" style={{ background: 'none', border: 0, color: 'var(--admin-text-on-brand)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0, marginRight: '0.4rem' }}><ChevronLeft size={18} /></button>
            )}
            <span style={{ fontWeight: '900', fontSize: '0.8rem', flex: 1 }}>
              {activeBookingId ? `Booking #${activeBookingId.slice(0, 8).toUpperCase()}` : 'Support Chat'}
            </span>
            <button onClick={closeChat} aria-label="Close support chat" style={{ background: 'none', border: 0, color: 'var(--admin-text-on-brand)', cursor: 'pointer' }}><X size={18} /></button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <BookingChat bookingId={activeBookingId || undefined} customerId={activeCustomerId} />
          </div>
        </div>
      )}

      {/* Keep the chat bubble as the sole affordance; no small side popup is
          shown while the thread remains closed. Users can see the unread badge on the bubble itself. */}
      {isOpen && !activeCustomerId && isAdminRole && (
        <div ref={chatRef} style={{ ...placePanel(chatWidth, chatHeight), background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', boxShadow: '0 20px 50px rgba(0,0,0,0.25)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)' }}>
            <span style={{ fontWeight: '900', fontSize: '0.8rem' }}>Customer Chats</span>
            <button onClick={closeChat} aria-label="Close chats" style={{ background: 'none', border: 0, color: 'var(--admin-text-on-brand)', cursor: 'pointer' }}><X size={18} /></button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {threadsLoading && threads.length === 0 && (
              <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.8rem', fontWeight: 700 }}>Loading conversations...</div>
            )}
            {!threadsLoading && threads.length === 0 && (
              <div style={{ padding: '2rem 1.5rem', textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.8rem', fontWeight: 700 }}>No customer conversations yet.</div>
            )}
            {threads.map((thread) => {
              const unread = Number(thread.unread_count) || 0;
              const tags = (thread.booking_ids || []).slice(0, 2);
              const extra = Math.max(0, (thread.booking_ids || []).length - tags.length);
              return (
                <button
                  key={thread.customer_id}
                  type="button"
                  onClick={() => openChatForCustomer(thread.customer_id)}
                  style={{ width: '100%', textAlign: 'left', display: 'flex', gap: '0.75rem', alignItems: 'flex-start', padding: '0.85rem 1rem', background: 'transparent', border: 0, borderBottom: '1px solid var(--admin-border)', cursor: 'pointer', color: 'var(--admin-text-primary)' }}
                >
                  <span style={{ width: 36, height: 36, flexShrink: 0, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', fontWeight: 900, fontSize: '0.8rem' }}>
                    {String(thread.customer_name || '?').trim().charAt(0).toUpperCase()}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <strong style={{ fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{thread.customer_name}</strong>
                      <span style={{ fontSize: '0.62rem', color: 'var(--admin-text-secondary)', flexShrink: 0 }}>
                        {thread.last_message_at ? new Date(thread.last_message_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                      </span>
                    </span>
                    <span style={{ display: 'block', fontSize: '0.74rem', color: unread ? 'var(--admin-text-primary)' : 'var(--admin-text-secondary)', fontWeight: unread ? 800 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {thread.last_message_type === 'image' ? 'Sent a photo' : thread.last_message_type === 'file' ? 'Sent a file' : (thread.last_message || '')}
                    </span>
                    {tags.length > 0 && (
                      <span style={{ display: 'flex', gap: '0.3rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
                        {tags.map((id) => (
                          <span key={id} style={{ fontSize: '0.58rem', fontWeight: 900, padding: '0.1rem 0.4rem', borderRadius: '4px', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)' }}>
                            #{String(id).slice(0, 8).toUpperCase()}
                          </span>
                        ))}
                        {extra > 0 && <span style={{ fontSize: '0.58rem', fontWeight: 900, color: 'var(--admin-text-secondary)' }}>+{extra}</span>}
                      </span>
                    )}
                  </span>
                  {unread > 0 && (
                    <span style={{ minWidth: 20, height: 20, padding: '0 5px', borderRadius: 999, background: 'var(--status-danger)', color: 'var(--admin-text-on-status)', display: 'grid', placeItems: 'center', fontSize: '0.62rem', fontWeight: 900, flexShrink: 0 }}>{unread > 99 ? '99+' : unread}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {isOpen && !activeCustomerId && !isAdminRole && (
        <div style={{ ...placePanel(hintWidth, 80), height: 'auto', padding: '1.25rem', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', boxShadow: '0 20px 50px rgba(0,0,0,0.25)', color: 'var(--admin-text-secondary)', fontSize: '0.8rem', fontWeight: '700' }}>
          Open a booking to start a support conversation.
        </div>
      )}

      <div style={{ position: 'fixed', left: bubble.x, top: bubble.y, width: BUBBLE, height: BUBBLE, zIndex: 10000, touchAction: 'none' }}>
      <button
        ref={bubbleRef}
        type="button"
        aria-label={isOpen ? 'Support chat open' : 'Open support chat'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ width: '100%', height: '100%', border: 'none', borderRadius: '50%', background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', display: 'grid', placeItems: 'center', cursor: isDragging ? 'grabbing' : 'grab', boxShadow: '0 8px 24px rgba(0,0,0,0.25)', position: 'relative' }}
      >
        <MessageCircle size={26} />
        {globalUnreadCount > 0 && !isOpen && <span style={{ position: 'absolute', top: '-4px', left: '-4px', minWidth: '21px', height: '21px', padding: '0 4px', borderRadius: '999px', background: 'var(--status-danger)', color: 'var(--admin-text-on-status)', border: '2px solid var(--admin-bg)', display: 'grid', placeItems: 'center', fontSize: '0.65rem', fontWeight: '900' }}>{globalUnreadCount > 99 ? '99+' : globalUnreadCount}</span>}
      </button>
      </div>
    </>
  );
};

export default FloatingBubbleChat;
