import React, { useState, useEffect, useRef } from 'react';
import { supabase, createUniqueChannel } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { Send, Image as ImageIcon, Bot, Check, CheckCheck, Loader2, AlertCircle, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { emitEventToMany, EVENTS } from '../services/eventEngine';
import { useGlobalChat } from '../context/ChatContext';

/**
 * BookingChat — the CUSTOMER's single real-time conversation.
 * Participants: Customer, Admin, Assigned Technician.
 * Supports text messages, image uploads, and system auto-messages.
 *
 * Section 2: the thread identity is the CUSTOMER, not the booking. A customer
 * has ONE continuous conversation across every booking; `bookingId` is now the
 * booking being viewed, used only to TAG outgoing messages with the booking they
 * relate to (booking_messages.booking_id, nullable).
 */
const BookingChat = ({ bookingId, customerId: customerIdProp }) => {
  const { user, profile } = useAuth();
  const { refreshUnreadCount, reportThreadUnread } = useGlobalChat();
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState(null);
  const [error, setError] = useState('');
  // Section 2: the resolved customer thread, and the booking the next message
  // will be tagged with. `tagBookingId` is nullable — a message may have no
  // booking context at all.
  const [customerId, setCustomerId] = useState(customerIdProp || null);
  const [tagBookingId, setTagBookingId] = useState(bookingId || '');
  const [bookingOptions, setBookingOptions] = useState([]);
  const bottomRef = useRef(null);
  const chatContainerRef = useRef(null);
  const fileRef = useRef(null);

  // --- FETCH MESSAGES ---
  const markMessagesAsRead = async (messageList) => {
    const unreadIds = messageList
      .filter(message => message.sender_id !== user?.id && !message.is_read)
      .map(message => message.id);
    if (unreadIds.length === 0) {
      await refreshUnreadCount();
      return;
    }

    const { error: readError } = await supabase
      .from('booking_messages')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .in('id', unreadIds);
    if (readError) console.error('Unable to mark chat messages as read:', readError);
    await refreshUnreadCount();
  };

  // Section 2: load the whole CUSTOMER thread. Every message the customer has
  // ever sent, across every booking, in one continuous timeline.
  const fetchMessages = async (resolvedCustomerId) => {
    const threadCustomerId = resolvedCustomerId || customerId;
    if (!threadCustomerId) return;

    const { data, error } = await supabase
      .from('booking_messages')
      .select('*, read_at, sender:profiles!booking_messages_sender_id_fkey(full_name, first_name, last_name, role)')
      .eq('customer_id', threadCustomerId)
      .order('created_at', { ascending: true });

    if (!error && data) {
      const conversationMessages = data.filter(message => message.message_type !== 'system');
      setMessages(conversationMessages);
      // Publish this thread's own unread count so the launcher can badge the
      // exact customer conversation instead of only showing a global total.
      reportThreadUnread(threadCustomerId, conversationMessages.filter(message => message.sender_id !== user?.id && !message.is_read).length);
      await markMessagesAsRead(conversationMessages);
    }
  };

  // Section 2: the bookings a message can be tagged with — the customer's own
  // bookings, newest first. Powers the tag selector in the composer.
  const fetchBookingOptions = async (threadCustomerId) => {
    if (!threadCustomerId) return;
    const { data, error } = await supabase
      .from('bookings')
      .select('id, status, created_at, vehicle_type, total_amount')
      .eq('customer_id', threadCustomerId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (!error && data) setBookingOptions(data);
  };

  useEffect(() => {
    if (!bookingId && !customerIdProp) return undefined;
    if (!user?.id) return undefined;
    // 🛡️ SCENARIO 6 — ACCOUNT REVOCATION.
    // If the profile reports the account is inactive (banned) or missing
    // (deleted), do NOT open a realtime channel at all. Previously the socket
    // was created regardless and every subsequent RLS-rejected read/write logged
    // an error, producing the infinite console loop this scenario describes.
    // An inactive account simply unmounts the conversation.
    const isRevoked = !profile || profile.is_active === false;
    if (isRevoked) {
      setMessages([]);
      reportThreadUnread(bookingId, 0);
      return undefined;
    }
    let active = true;
    let channel;
    const startChat = async () => {
      // Section 2: resolve the owning CUSTOMER for this thread. Either the parent
      // passed one directly, or we read it off the booking being viewed.
      let threadCustomerId = customerIdProp || null;
      if (!threadCustomerId && bookingId) {
        const { data: booking, error: bookingError } = await supabase
          .from('bookings')
          .select('customer_id')
          .eq('id', bookingId)
          .maybeSingle();
        // Scenario 6: an RLS/authorization failure here means the session is no
        // longer entitled to this booking (revoked/banned). Do not retry and do
        // not open a channel — surface a single, calm state instead of looping.
        if (bookingError) {
          console.warn('[Chat] Conversation unavailable (session revoked or access denied).');
          setMessages([]);
          reportThreadUnread(bookingId, 0);
          return;
        }
        threadCustomerId = booking?.customer_id || null;
      }

      if (!active || !threadCustomerId) {
        setMessages([]);
        reportThreadUnread(bookingId || customerIdProp, 0);
        return;
      }

      setCustomerId(threadCustomerId);
      await Promise.all([
        fetchMessages(threadCustomerId),
        fetchBookingOptions(threadCustomerId)
      ]);

      // Real-time subscription is created only after the thread is confirmed to
      // belong to a registered customer account, and is scoped to the WHOLE
      // customer conversation — not a single booking.
      // A unique topic is required: the bubble chat and an inline chat panel can
      // be mounted for the same customer at once, and reusing the topic would
      // append to an already-subscribed channel (see createUniqueChannel).
      channel = createUniqueChannel(`chat-customer-${threadCustomerId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'booking_messages',
          filter: `customer_id=eq.${threadCustomerId}`
        }, (payload) => {
          if (payload.new.message_type === 'system') return;
          setMessages(prev => {
            const filtered = prev.filter(m => !(m.status === 'sending' && m.message === payload.new.message));
            if (!filtered.some(m => m.id === payload.new.id)) return [...filtered, payload.new];
            return filtered;
          });
          if (payload.new.sender_id !== user.id) {
            supabase.from('booking_messages').update({ is_read: true, read_at: new Date().toISOString() }).eq('id', payload.new.id).then(async ({ error: readError }) => {
              if (readError) console.error('Unable to mark incoming message as read:', readError);
              else await refreshUnreadCount();
            });
          }
          fetchMessages(threadCustomerId);
        })
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'booking_messages',
          filter: `customer_id=eq.${threadCustomerId}`
        }, (payload) => {
          setMessages(prev => prev.map(message => message.id === payload.new.id ? { ...message, ...payload.new } : message));
        })
        .subscribe((status) => {
          if (status === 'CLOSED' || status === 'CHANNEL_ERROR') console.warn('Chat connection temporarily offline. Reconnecting...');
        });
    };
    startChat();

    return () => {
      active = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [bookingId, customerIdProp, user?.id, profile, refreshUnreadCount, reportThreadUnread]);

  // Section 2: keep the tag selector pointed at the booking in view when the
  // parent changes it, but never silently drop a tag the user chose.
  useEffect(() => {
    if (bookingId) setTagBookingId(bookingId);
  }, [bookingId]);

  // Smart Auto-scroll (REQ-NFR-30)
  const prevMsgCount = useRef(0);
  useEffect(() => {
    if (messages.length === 0) return;
    const container = chatContainerRef.current;
    if (!container) return;

    // Check if user is already near bottom (within 100px)
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;

    if (isNearBottom || prevMsgCount.current === 0) {
      container.scrollTo({ top: container.scrollHeight, behavior: prevMsgCount.current === 0 ? 'auto' : 'smooth' });
    } else if (messages.length > prevMsgCount.current) {
      toast('New message received below', { icon: '⬇️', position: 'top-center' });
    }
    prevMsgCount.current = messages.length;
  }, [messages]);

    // --- SEND MESSAGE ---
    const handleSend = async (retryMessage = null) => {
    const textToSend = retryMessage?.message || newMessage.trim();
    if ((!textToSend && !attachment) || sending) return;
    setError('');

    const tempId = retryMessage?.id || `temp-${Date.now()}`;
    setSending(true);

    if (!retryMessage) {
      // Optimistically append to state
      const optimisticMsg = {
        id: tempId,
        // Section 2: the thread key is customer_id; booking_id is the tag.
        customer_id: customerId,
        booking_id: tagBookingId || null,
        sender_id: user?.id || profile?.id,
        message: textToSend,
        message_text: textToSend,
        message_type: 'text',
        created_at: new Date().toISOString(),
        status: 'sending',
        sender: profile ? { first_name: profile.first_name, role: profile.role } : null
      };
      setMessages(prev => [...prev, optimisticMsg]);
      setNewMessage('');
    } else {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'sending' } : m));
    }

    try {
      const { error } = await supabase.from('booking_messages').insert({
        customer_id: customerId,
        // Nullable: the previous message selected in the tag selector, or null
        // when the message carries no booking context at all.
        booking_id: tagBookingId || null,
        sender_id: user?.id || profile?.id,
        message: textToSend,
        message_type: 'text',
        is_read: false
      });
      if (error) throw error;
      const { data: admins } = await supabase.from('profiles').select('id').eq('role', 'ADMIN').eq('is_active', true);
      const recipients = [...new Set([
        customerId,
        ...(admins || []).map(admin => admin.id)
      ].filter(recipientId => recipientId && recipientId !== (user?.id || profile?.id)))];
      if (recipients.length > 0) {
        await emitEventToMany(EVENTS.MESSAGE_RECEIVED, {
          userIds: recipients,
          bookingId: tagBookingId || null,
          meta: {
            bookingRef: tagBookingId ? tagBookingId.substring(0, 8).toUpperCase() : 'GENERAL',
            senderName: profile?.full_name || profile?.first_name || 'A user',
            messageText: textToSend
          }
        });
      }
      toast.success('Message sent securely', { position: 'top-center' });
    } catch (err) {
      console.error('Send error:', {
        code: err?.code,
        status: err?.status,
        message: err?.message,
        details: err?.details,
        hint: err?.hint,
        raw: err
      });
      setError(err?.message || 'Failed to send message. Please try again.');
      // Fallback to error state
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m));
    } finally {
      setSending(false);
    }
  };

  // --- SEND IMAGE ---
  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('Attachments must be 5MB or smaller.');
      e.target.value = '';
      return;
    }

    setError('');
    setAttachment(file);
    e.target.value = '';
  };

  const handleSendAttachment = async () => {
    if (!attachment || sending) return;
    setSending(true);
    setError('');
    try {
      const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = `chat/${customerId || bookingId}/${Date.now()}_${safeName}`;
      const { error: uploadErr } = await supabase.storage.from('chat_media').upload(filePath, attachment);
      if (uploadErr) throw uploadErr;

      const { data: { publicUrl } } = supabase.storage.from('chat_media').getPublicUrl(filePath);
      const isImage = attachment.type.startsWith('image/');
      const { error: insertError } = await supabase.from('booking_messages').insert({
        customer_id: customerId,
        booking_id: tagBookingId || null,
        sender_id: user.id,
        message: publicUrl,
        // Store the human-readable filename, NOT the storage URL. The chat
        // notification is built from message_text, so a URL here produced
        // notification rows full of signed-link noise.
        message_text: safeName,
        message_type: isImage ? 'image' : 'file',
        is_read: false
      });
      if (insertError) throw insertError;
      const { data: admins } = await supabase.from('profiles').select('id').eq('role', 'ADMIN').eq('is_active', true);
      const recipients = [...new Set([
        customerId,
        ...(admins || []).map(admin => admin.id)
      ].filter(recipientId => recipientId && recipientId !== user.id))];
      if (recipients.length > 0) {
        await emitEventToMany(EVENTS.MESSAGE_RECEIVED, {
          userIds: recipients,
          bookingId: tagBookingId || null,
          meta: {
            bookingRef: tagBookingId ? tagBookingId.substring(0, 8).toUpperCase() : 'GENERAL',
            senderName: profile?.full_name || profile?.first_name || 'A user',
            messageText: safeName,
            isAttachment: true,
            attachmentType: isImage ? 'image' : 'file'
          }
        });
      }
      setAttachment(null);
      toast.success('Attachment sent securely', { position: 'top-center' });
    } catch (err) {
      console.error('Image upload error:', err);
      setError('Failed to upload attachment. Please try again.');
    } finally {
      setSending(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSubmit = async () => {
    if (sending || (!newMessage.trim() && !attachment)) return;
    if (newMessage.trim()) await handleSend();
    if (attachment) await handleSendAttachment();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // --- RENDER HELPERS ---
  const getRoleColor = (role) => {
    switch (role) {
      case 'ADMIN': return '#ef4444';
      case 'STAFF': return '#a855f7';
      case 'CUSTOMER': return 'var(--admin-brand)';
      default: return 'var(--admin-text-secondary)';
    }
  };

  const getRoleLabel = (role) => {
    switch (role) {
      case 'ADMIN': return 'Admin';
      case 'STAFF': return 'Technician';
      case 'CUSTOMER': return 'Customer';
      default: return 'System';
    }
  };

  const timeFormat = (ts) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-md)', overflow: 'hidden' }}>

      {/* Message Area */}
      <div ref={chatContainerRef} style={{ flex: 1, padding: '1rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {messages.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', opacity: 0.4 }}>
            <Bot size={32} />
            <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--admin-text-secondary)', textAlign: 'center' }}>
              No messages yet.<br/>Start a conversation about this booking.
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.sender_id === user?.id;
            const isSystem = msg.message_type === 'system';
            const senderName = msg.sender
              ? msg.sender.full_name || `${msg.sender.first_name || ''} ${msg.sender.last_name || ''}`.trim() || 'Unknown'
              : 'Unknown';
            const senderRole = msg.sender?.role || 'SYSTEM';

            if (isSystem) {
              return (
                <div key={msg.id} style={{ textAlign: 'center', fontSize: '0.7rem', fontWeight: '700', color: 'var(--admin-text-secondary)', background: 'rgba(var(--admin-brand-rgb), 0.03)', padding: '0.4rem 1rem', borderRadius: '20px', margin: '0.25rem auto', maxWidth: '80%' }}>
                  {msg.message}
                </div>
              );
            }

            return (
              <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start', gap: '0.2rem' }}>
                {/* Sender Label */}
                {!isMe && (
                  <div style={{ fontSize: '0.65rem', fontWeight: '900', color: getRoleColor(senderRole), textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.1rem' }}>
                    {senderName} • {getRoleLabel(senderRole)}
                  </div>
                )}

                {/* Section 2: show which booking a message was tagged with, so the
                    continuous customer thread keeps its booking context visible. */}
                {msg.booking_id && (
                  <div style={{ fontSize: '0.58rem', fontWeight: 900, color: 'var(--admin-text-secondary)', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '999px', padding: '0.12rem 0.5rem', letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                    Re: #{String(msg.booking_id).slice(0, 8).toUpperCase()}
                  </div>
                )}

                {/* Bubble */}
                {msg.message_type === 'image' ? (
                  <img
                    src={msg.message}
                    alt="attachment"
                    style={{ maxWidth: '200px', maxHeight: '200px', borderRadius: 'var(--admin-radius-sm)', border: '1px solid var(--admin-border)', cursor: 'zoom-in', objectFit: 'cover', opacity: msg.status === 'sending' ? 0.6 : 1 }}
                    onClick={() => window.open(msg.message, '_blank')}
                  />
                ) : msg.message_type === 'file' ? (
                  <a href={msg.message} target="_blank" rel="noreferrer" style={{ color: isMe ? '#fff' : 'var(--admin-brand)', fontWeight: '800', textDecoration: 'underline' }}>
                    Open attachment
                  </a>
                ) : (
                  <div style={{
                    background: isSystem ? 'rgba(var(--admin-brand-rgb), 0.05)' : (isMe ? 'var(--admin-brand)' : 'var(--admin-card)'),
                    color: isSystem ? 'var(--admin-text-secondary)' : (isMe ? '#fff' : 'var(--admin-text-primary)'),
                    padding: '0.6rem 1rem',
                    borderRadius: isMe ? '1rem 1rem 0.25rem 1rem' : '1rem 1rem 1rem 0.25rem',
                    maxWidth: '75%',
                    fontSize: '0.85rem',
                    fontWeight: '600',
                    lineHeight: 1.5,
                    wordBreak: 'break-word',
                    border: isMe ? 'none' : '1px solid var(--admin-border)',
                    opacity: msg.status === 'sending' ? 0.7 : 1
                  }}>
                    {msg.message}
                  </div>
                )}

                {/* Status / Timestamp */}
                <div style={{ fontSize: '0.6rem', fontWeight: '700', color: 'var(--admin-text-secondary)', marginTop: '0.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {msg.status === 'sending' && <span>Sending...</span>}
                  {msg.status === 'failed' && (
                    <span style={{ color: 'var(--status-danger)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      Failed
                      <button onClick={() => handleSend(msg)} style={{ background: 'none', border: 'none', color: 'var(--status-danger)', textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: '0.6rem', fontWeight: 'bold' }}>Retry</button>
                    </span>
                  )}
                  {msg.status !== 'sending' && msg.status !== 'failed' && <span>{timeFormat(msg.created_at)}</span>}
                  {isMe && msg.status !== 'sending' && msg.status !== 'failed' && (msg.is_read
                    ? <span title={`Seen${msg.read_at ? ` ${timeFormat(msg.read_at)}` : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', color: '#34d399', fontWeight: '900' }}><CheckCheck size={13} /> Seen</span>
                    : <span title="Delivered — not opened yet" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}><Check size={13} /> Sent</span>)}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Section 2: booking tag selector. A message may be tagged with a specific
          booking (nullable) so the single customer thread keeps booking context. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', borderTop: '1px solid var(--admin-border)', background: 'var(--admin-bg)' }}>
        <label htmlFor="chat-booking-tag" style={{ fontSize: '0.6rem', fontWeight: 950, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
          Tag booking
        </label>
        <select
          id="chat-booking-tag"
          name="chat_booking_tag"
          value={tagBookingId || ''}
          onChange={(e) => setTagBookingId(e.target.value)}
          style={{ flex: 1, minWidth: 0, padding: '0.35rem 0.6rem', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', color: 'var(--admin-text-primary)', fontSize: '0.7rem', fontWeight: 800, outline: 'none' }}
        >
          {/* Nullable tag: a message is allowed to carry no booking context. */}
          <option value="">No booking (general inquiry)</option>
          {bookingOptions.map((booking) => (
            <option key={booking.id} value={booking.id}>
              #{booking.id.slice(0, 8).toUpperCase()} • {booking.vehicle_type || 'Service'} • {new Date(booking.created_at).toLocaleDateString('en-US')}
            </option>
          ))}
        </select>
      </div>

      {/* Input Area */}
      <div style={{ position: 'relative', padding: '0.75rem 1rem', borderTop: '1px solid var(--admin-border)', display: 'flex', gap: '0.5rem', alignItems: 'center', background: 'var(--admin-card)' }}>
        {error && <div role="alert" style={{ position: 'absolute', transform: 'translateY(-100%)', left: '1rem', right: '1rem', padding: '0.5rem 0.75rem', background: 'rgba(239, 68, 68, 0.12)', color: 'var(--status-danger)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.35rem', borderRadius: '4px' }}><AlertCircle size={14} /> {error}</div>}
        {attachment && <div style={{ position: 'absolute', transform: 'translateY(-100%)', left: '1rem', right: '1rem', padding: '0.5rem 0.75rem', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span>{attachment.name} ({(attachment.size / 1024 / 1024).toFixed(2)} MB)</span><button type="button" onClick={() => setAttachment(null)} aria-label="Remove attachment" style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}><X size={14} /></button></div>}
        <input type="file" ref={fileRef} accept="image/*,.pdf" onChange={handleImageUpload} style={{ display: 'none' }} />
        <button 
          onClick={() => fileRef.current?.click()}
          style={{ background: 'none', border: 'none', color: 'var(--admin-text-secondary)', cursor: 'pointer', padding: '0.25rem' }}
        >
          <ImageIcon size={20} />
        </button>
        <input
          type="text"
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          style={{
            flex: 1, background: 'var(--admin-bg)', border: '1px solid var(--admin-border)',
            padding: '0.6rem 1rem', borderRadius: '20px', color: 'var(--admin-text-primary)',
            fontSize: '0.85rem', outline: 'none'
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={(!newMessage.trim() && !attachment) || sending}
          style={{
            background: (newMessage.trim() || attachment) ? 'var(--admin-brand)' : 'var(--admin-bg)',
            color: (newMessage.trim() || attachment) ? '#fff' : 'var(--admin-text-secondary)',
            border: 'none', borderRadius: '50%',
            width: '36px', height: '36px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: (newMessage.trim() || attachment) ? 'pointer' : 'not-allowed',
            transition: 'all 0.2s'
          }}
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
};

export default BookingChat;
