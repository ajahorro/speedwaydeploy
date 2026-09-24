import React, { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';
import { createBooking } from '../../services/bookingService';
import { getRequiredDownpayment, requiresDownpayment } from '../../utils/paymentUtils';
import { sanitizeVehicleText, sanitizeVehiclePlate } from '../../config/constants';
import CustomerBookAppointment from '../Customer/CustomerBookAppointment';
import toast from 'react-hot-toast';

const AdminWalkInWizard = () => {
  const { user } = useAuth();
  const [isNewGuest, setIsNewGuest] = useState(true);
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [guest, setGuest] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  // Identity-collision detection: a guest email that already belongs to a
  // registered CUSTOMER must not be silently booked as an account-less guest.
  // We look it up (debounced) and, when found, prompt the admin to either LINK
  // the booking to that account or intentionally continue as a guest.
  const [emailMatch, setEmailMatch] = useState(null); // { id, full_name, email } | null
  const [checkingEmail, setCheckingEmail] = useState(false);
  // GU-1: tracks an EXPLICIT "Continue as guest" decision. Only this flag turns
  // the auto-link safety net off; a merely-unresolved debounce lookup must NOT
  // disable it (that was the bug — the net could never fire).
  const [guestAsGuest, setGuestAsGuest] = useState(false);

  useEffect(() => {
    Promise.all([
      supabase.from('profiles').select('id, full_name, email, phone_number').eq('role', 'CUSTOMER').eq('is_active', true).order('full_name'),
    ]).then(([customerResult]) => {
      setCustomers(customerResult.data || []);
    });
  }, []);

  // Debounced collision check: whenever the guest email changes, look for an
  // existing CUSTOMER account with the same email (case-insensitive). This is a
  // best-effort pre-flight; the authoritative identity decision is the admin's
  // choice in the warning UI below.
  useEffect(() => {
    const email = String(guest.email || '').trim().toLowerCase();
    if (!isNewGuest || !email || !email.includes('@')) {
      setEmailMatch(null);
      return undefined;
    }
    let cancelled = false;
    setCheckingEmail(true);
    const t = setTimeout(async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .eq('role', 'CUSTOMER')
        .ilike('email', email)
        .maybeSingle();
      if (cancelled) return;
      setCheckingEmail(false);
      setEmailMatch(error ? null : (data || null));
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [guest.email, isNewGuest]);

  const renderAdminPanel = ({ bookingData, setBookingData, isCustomerDetailsLocked }) => {
    const updateCustomerMode = mode => {
      if (isCustomerDetailsLocked) return;
      setIsNewGuest(mode);
      setSelectedCustomer('');
      setGuest({ firstName: '', lastName: '', email: '', phone: '' });
      // Switching mode resets the explicit guest decision too.
      setEmailMatch(null);
      setGuestAsGuest(false);
      setBookingData(current => ({ ...current, customerId: null, customerName: '', customerEmail: '', contactNumber: '', adminCustomerReady: false }));
    };
    const fieldStyle = { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '.85rem 1rem', background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-input-border)', borderRadius: 0, fontWeight: '700' };
    return (
      <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem', padding: '1.25rem', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}><UserPlus size={18} color="var(--admin-brand)" /><strong style={{ color: 'var(--admin-text-primary)', textTransform: 'uppercase' }}>Admin Customer Selection</strong></div>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <button type="button" disabled={isCustomerDetailsLocked} onClick={() => updateCustomerMode(false)} style={{ padding: '.75rem 1rem', border: '1px solid var(--admin-border)', background: !isNewGuest ? 'var(--admin-brand)' : 'var(--admin-bg)', color: !isNewGuest ? '#fff' : 'var(--admin-text-primary)', borderRadius: 0, fontWeight: '900', cursor: isCustomerDetailsLocked ? 'not-allowed' : 'pointer', opacity: isCustomerDetailsLocked ? .65 : 1 }}>Existing Customer</button>
          <button type="button" disabled={isCustomerDetailsLocked} onClick={() => updateCustomerMode(true)} style={{ padding: '.75rem 1rem', border: '1px solid var(--admin-border)', background: isNewGuest ? 'var(--admin-brand)' : 'var(--admin-bg)', color: isNewGuest ? '#fff' : 'var(--admin-text-primary)', borderRadius: 0, fontWeight: '900', cursor: isCustomerDetailsLocked ? 'not-allowed' : 'pointer', opacity: isCustomerDetailsLocked ? .65 : 1 }}>Walk-in Guest</button>
        </div>
        {isNewGuest ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '.75rem' }}>
            <input disabled={isCustomerDetailsLocked} style={fieldStyle} placeholder="First name" value={guest.firstName} onChange={event => { const firstName = event.target.value.replace(/[^a-zA-Z ]/g, '').replace(/\s+/g, ' '); setGuest(current => ({ ...current, firstName })); setBookingData(current => ({ ...current, customerId: null, customerName: `${firstName} ${guest.lastName}`.trim(), adminCustomerReady: Boolean(firstName.trim() && guest.lastName.trim() && guest.email.trim() && guest.phone.trim()) })); }} />
            <input disabled={isCustomerDetailsLocked} style={fieldStyle} placeholder="Last name" value={guest.lastName} onChange={event => { const lastName = event.target.value.replace(/[^a-zA-Z ]/g, '').replace(/\s+/g, ' '); setGuest(current => ({ ...current, lastName })); setBookingData(current => ({ ...current, customerId: null, customerName: `${guest.firstName} ${lastName}`.trim(), adminCustomerReady: Boolean(guest.firstName.trim() && lastName.trim() && guest.email.trim() && guest.phone.trim()) })); }} />
            <input disabled={isCustomerDetailsLocked} style={fieldStyle} placeholder="Email" type="email" value={guest.email} onChange={event => { const email = event.target.value.replace(/[^a-zA-Z0-9@._+-]/g, ''); setGuest(current => ({ ...current, email })); setBookingData(current => ({ ...current, customerEmail: email, adminCustomerReady: Boolean(guest.firstName.trim() && guest.lastName.trim() && email.trim() && guest.phone.trim()) })); }} />
            <input disabled={isCustomerDetailsLocked} style={fieldStyle} placeholder="Phone" inputMode="numeric" value={guest.phone} onChange={event => { const phone = event.target.value.replace(/\D/g, ''); setGuest(current => ({ ...current, phone })); setBookingData(current => ({ ...current, contactNumber: phone, adminCustomerReady: Boolean(guest.firstName.trim() && guest.lastName.trim() && guest.email.trim() && phone.trim()) })); }} />
          </div>
        ) : (
          <select disabled={isCustomerDetailsLocked} style={fieldStyle} value={selectedCustomer} onChange={event => { const id = event.target.value; const profile = customers.find(customer => customer.id === id); setSelectedCustomer(id); setBookingData(current => ({ ...current, customerId: id, customerName: profile?.full_name || '', customerEmail: profile?.email || '', contactNumber: profile?.phone_number || '', adminCustomerReady: Boolean(id) })); }}>
            <option value="">Choose customer account</option>
            {customers.map(customer => <option key={customer.id} value={customer.id}>{customer.full_name || customer.email}</option>)}
          </select>
        )}

        {/* Identity-collision guard: the typed guest email already belongs to a
            registered customer. Silently booking it as an account-less guest
            would orphan the booking (no account link, no chat, no history). We
            surface it and let the admin link the booking to that account — or
            knowingly keep it as a guest. */}
        {isNewGuest && emailMatch && !guestAsGuest && !isCustomerDetailsLocked && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', padding: '.85rem 1rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.45)', borderRadius: 0 }}>
            <span style={{ fontSize: '.78rem', fontWeight: 800, color: 'var(--status-warning)' }}>
              This email belongs to an existing account: <strong>{emailMatch.full_name || emailMatch.email}</strong>.
            </span>
            <span style={{ fontSize: '.72rem', color: 'var(--admin-text-secondary)' }}>
              Booking as a guest would create an unlinked record that will not appear in that customer's account. Link it instead?
            </span>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => {
                  const profile = customers.find(c => c.id === emailMatch.id) || emailMatch;
                  setIsNewGuest(false);
                  setSelectedCustomer(emailMatch.id);
                  setGuestAsGuest(false);
                  setBookingData(current => ({ ...current, customerId: emailMatch.id, customerName: profile.full_name || '', customerEmail: profile.email || '', contactNumber: profile.phone_number || current.contactNumber || '', adminCustomerReady: true }));
                }}
                style={{ padding: '.55rem .9rem', background: 'var(--admin-brand)', color: '#fff', border: '1px solid var(--admin-brand)', borderRadius: 0, fontWeight: 900, fontSize: '.72rem', cursor: 'pointer' }}
              >
                Link to this account
              </button>
              <button
                type="button"
                onClick={() => { setGuestAsGuest(true); setEmailMatch(null); }}
                style={{ padding: '.55rem .9rem', background: 'transparent', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', borderRadius: 0, fontWeight: 800, fontSize: '.72rem', cursor: 'pointer' }}
              >
                Continue as guest
              </button>
            </div>
          </div>
        )}
      </section>
    );
  };

  const submitAdminBooking = async bookingData => {
    if (!bookingData.customerName || !bookingData.contactNumber) throw new Error('Complete the customer details before confirming.');

    // Identity resolution safety net. If this is a guest booking whose email
    // belongs to a registered customer, LINK the booking to that account rather
    // than orphaning it.
    //
    // GU-1 fix: the previous version could never link anything. It guarded on
    // `(!emailMatch || emailMatch.id === existing.id)` and then only assigned
    // when `emailMatch?.id === existing.id` — so in the exact case the net was
    // written for (a dismissed prompt or a debounce that had not resolved,
    // i.e. emailMatch === null) the assignment never happened.
    //
    // The correct rule: an explicit "Continue as guest" DISABLES the net for
    // that attempt; anything else (no match yet, or an unresolved lookup) means
    // we link to the account that genuinely owns the address.
    let resolvedCustomerId = bookingData.customerId ?? null;
    const guestEmail = String(bookingData.customerEmail || '').trim().toLowerCase();
    const guestContinuedExplicitly = guestAsGuest; // set by "Continue as guest"
    if (!resolvedCustomerId && guestEmail.includes('@') && !guestContinuedExplicitly) {
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'CUSTOMER')
        .ilike('email', guestEmail)
        .maybeSingle();
      if (existing?.id) {
        resolvedCustomerId = existing.id;
      }
    }

    const paymentType = bookingData.payment?.type || 'Full';
    const totalAmount = Number(bookingData.total_amount || (bookingData.vehicles || []).reduce((total, vehicle) => total + (vehicle.services || []).reduce((sum, service) => sum + Number(service.price || 0), 0), 0));
    const paymentAmount = paymentType === 'Downpayment'
      ? getRequiredDownpayment(totalAmount)
      : paymentType === 'Manual' ? Number(bookingData.payment?.manualAmount || 0) : totalAmount;
    if (!paymentAmount || paymentAmount <= 0 || paymentAmount > totalAmount || (paymentType === 'Downpayment' && !requiresDownpayment(totalAmount))) {
      throw new Error('Choose a valid payment amount before confirming the walk-in booking.');
    }
    const booking = await createBooking(resolvedCustomerId, {
      ...bookingData,
      adminWalkIn: true,
      adminActorId: user?.id || null,
      notes: `${bookingData.notes || ''} WALK-IN`,
      customerId: resolvedCustomerId,
      // Never let the admin's own identity leak into the customer-facing record.
      // For guest walk-ins there is no profile, so these booking columns are the
      // only source of the customer name/contact used by the confirmation email.
      customerName: bookingData.customerName,
      contactNumber: bookingData.contactNumber,
      customerEmail: bookingData.guest?.email || bookingData.customerEmail || null
    });
    toast.success('Walk-in booking created and confirmed.');
  };

  // Fired by the wizard after a successful submit so the next walk-in starts
  // from a clean slate (customer fields, unit cards, Add New Vehicle gate).
  const handleAdminReset = () => {
    setIsNewGuest(true);
    setSelectedCustomer('');
    setGuest({ firstName: '', lastName: '', email: '', phone: '' });
    // Clear both identity-collision signals so the next walk-in starts neutral.
    setEmailMatch(null);
    setGuestAsGuest(false);
  };

  return <CustomerBookAppointment adminMode renderAdminPanel={renderAdminPanel} onAdminSubmit={submitAdminBooking} onAdminReset={handleAdminReset} />;
};

export default AdminWalkInWizard;
