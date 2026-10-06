import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from '@/lib/toast';
import { CalendarCheck, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { subscribeTable } from '../lib/realtimeHub';
import { useAuth } from '../hooks/useAuth';
import { useConfirmAction } from '../hooks/useConfirmAction';
import { loadDraft, slimDraftData, writeLocalDraft, saveServerDraft } from '../services/bookingDraftService';

/**
 * The "send me your booking details" invitation inside the chat.
 *   Customer: a button that sends the booking they saved on this device or account to the shop.
 *   Administrator: waits for the customer, then "Book for customer" opens the walk-in form already
 *   filled in, with the customer's account chosen. The receipt photo is handled in that form by hand.
 */
export default function BookingInviteCard({ message }) {
  const { user, profile } = useAuth();
  const { confirmThen } = useConfirmAction();
  const navigate = useNavigate();
  const [invite, setInvite] = useState(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = String(profile?.role || '').toUpperCase() === 'ADMIN';

  const load = useCallback(async () => {
    if (!message.invite_id) return;
    const { data } = await supabase
      .from('booking_draft_invites')
      .select('id, status, expires_at, customer_id')
      .eq('id', message.invite_id)
      .maybeSingle();
    setInvite(data || null);
  }, [message.invite_id]);

  useEffect(() => {
    load();
    if (!message.invite_id) return undefined;
    return subscribeTable({ table: 'booking_draft_invites', event: 'UPDATE', filter: `id=eq.${message.invite_id}` }, () => load());
  }, [load, message.invite_id]);

  // re-check the clock so an ignored invitation disappears on its own (no countdown is shown)
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 10000);
    return () => clearInterval(timer);
  }, []);

  const expired = invite && ['SENT', 'SHARED'].includes(invite.status) && new Date(invite.expires_at) <= new Date();
  const state = !invite ? 'LOADING' : expired ? 'EXPIRED' : invite.status;

  const send = async () => {
    setBusy(true);
    try {
      const draft = await loadDraft(user.id, 'customer');
      if (!draft) {
        toast.error('You do not have a saved booking to send yet. Start a booking, choose your vehicles, services, and time, then tap this again.');
        return;
      }
      const { error } = await supabase.rpc('share_booking_draft', { p_invite_id: invite.id, p_data: slimDraftData(draft.data), p_step: draft.step || 1 });
      if (error) throw error;
      toast.success('Your booking details were sent to the shop.');
      load();
    } catch (error) {
      toast.error(error?.message || 'Your booking details could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const openForBooking = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('use_booking_draft_invite', { p_invite_id: invite.id });
      if (error) throw error;
      const draft = { data: { ...data.data, adminCustomerReady: true, customerId: data.customer_id }, step: data.step || 1,
        extras: { isNewGuest: false, selectedCustomer: data.customer_id, guest: { firstName: '', lastName: '', email: '', phone: '' }, guestAsGuest: false } };
      writeLocalDraft(user.id, 'admin_walkin', draft);
      await saveServerDraft(user.id, 'admin_walkin', draft);
      navigate('/admin/walk-in');
    } catch (error) {
      toast.error(error?.message || 'The booking details could not be opened.');
      setBusy(false);
    }
  };

  const askOpen = async () => {
    const existing = await loadDraft(user.id, 'admin_walkin');
    if (existing) {
      confirmThen({ title: 'Replace your unfinished walk-in booking?', message: 'You have a walk-in booking in progress. Opening this customer\'s details replaces it.', confirmText: 'Replace and open' }, openForBooking);
    } else {
      openForBooking();
    }
  };

  const button = (label, onClick) => (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{ marginTop: '0.6rem', padding: '0.65rem 1rem', minHeight: '44px', background: 'var(--admin-brand)', color: '#fff', border: 'none', borderRadius: 'var(--admin-radius-sm)', fontWeight: 900, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <CalendarCheck size={14} />} {label}
    </button>
  );

  // not tapped within 2 minutes, or replaced by a newer one: nothing is shown
  if (state === 'CANCELLED' || (state === 'EXPIRED' && invite?.status === 'SENT')) return null;

  let body = null;
  if (state === 'SENT') {
    body = isAdmin
      ? <div style={{ marginTop: '0.4rem', fontWeight: 700 }}>Waiting for the customer to send their booking details.</div>
      : button('Send my booking details', () => confirmThen({ title: 'Send your booking details?', message: 'The booking you saved (vehicles, services, date and time) will be sent to Comar Garage so they can book for you. Your payment receipt is not included.', confirmText: 'Send' }, send));
  } else if (state === 'SHARED') {
    body = isAdmin
      ? button('Book for customer', askOpen)
      : <div style={{ marginTop: '0.4rem', fontWeight: 700 }}>You sent your booking details. The shop will book for you. Please give your payment receipt photo to the shop.</div>;
  } else if (state === 'USED') {
    body = <div style={{ marginTop: '0.4rem', fontWeight: 700 }}>{isAdmin ? 'These details were opened for booking.' : 'The shop opened your details to make the booking.'}</div>;
  } else if (state === 'EXPIRED') {
    body = <div style={{ marginTop: '0.4rem', fontWeight: 700 }}>This invitation has expired. {isAdmin ? 'Send a new one.' : 'Ask the shop for a new one.'}</div>;
  } else if (state === 'CANCELLED') {
    body = <div style={{ marginTop: '0.4rem', fontWeight: 700 }}>This invitation was replaced by a newer one.</div>;
  }

  return (
    <div style={{ alignSelf: 'center', width: 'min(100%, 22rem)', background: 'var(--admin-card)', border: '1px solid var(--admin-brand)', borderRadius: '0.75rem', padding: '0.85rem 1rem', color: 'var(--admin-text-primary)', fontSize: '0.82rem' }}>
      <div style={{ fontWeight: 950, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--admin-brand)', marginBottom: '0.35rem' }}>Book for customer</div>
      <div style={{ fontWeight: 600, lineHeight: 1.45 }}>{message.message}</div>
      {body}
    </div>
  );
}
