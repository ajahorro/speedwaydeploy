import React from 'react';
import { Calendar, User, Wrench, CreditCard, CheckCircle } from 'lucide-react';
import { formatBookingDate, formatBookingTime } from '../utils/bookingHelpers';
import { derivePaymentStatusBadge } from '../utils/paymentUtils';

const LIFECYCLE_STEPS = ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'RELEASED'];

/**
 * The booking's own customer identity, in priority order:
 *   1. the linked account's profile (customer.first_name/last_name/full_name)
 *   2. the snapshot columns captured at booking time (customer_name)
 *   3. the guest details from the booking wizard (guest_name / contact)
 * Falls back to a neutral label so a walk-in is never blank.
 */
const customerName = (booking) => {
  const c = booking?.customer || {};
  const full = c.full_name
    || [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
    || booking?.customer_name
    || booking?.guest_name
    || booking?.contact_name;
  return (full && String(full).trim()) || 'Walk-in Guest';
};

/** The customer's email from the profile or the booking snapshot, or '' when none. */
const customerEmail = (booking) => {
  const c = booking?.customer || {};
  const email = c.email || booking?.customer_email || booking?.guest_email || '';
  return String(email || '').trim();
};

const BookingSummaryHeader = ({ booking, onUnitCollected, showCustomer = true, showTechnician = true, paymentStatus }) => {
  const rawStatus = booking?.status?.toUpperCase() || 'PENDING';
  const normalizedStatus = rawStatus === 'PENDING' ? 'SCHEDULED' : rawStatus;
  const currentStepIndex = Math.max(0, LIFECYCLE_STEPS.indexOf(normalizedStatus));

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: '1.5rem',
        backgroundColor: 'var(--admin-card)', border: '1px solid var(--admin-border)',
        borderRadius: 'var(--admin-radius)', padding: '1.5rem',
        boxShadow: 'var(--admin-card-shadow)', width: '100%', marginBottom: '0.25rem', paddingBottom: '1rem'
      }}
    >
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '1.5rem', justifyContent: 'space-between',
        borderBottom: '1px solid var(--admin-border)', paddingBottom: '1.5rem'
      }}>
        <SummaryItem icon={Calendar} label="Schedule Time">
          {booking?.start_datetime ? `${formatBookingDate(booking.start_datetime)} at ${formatBookingTime(booking.start_datetime)}` : 'Unscheduled'}
        </SummaryItem>
        {showTechnician && (
          <SummaryItem icon={Wrench} label="Assigned Technician">
            {booking?.assigned_staff?.full_name || 'Unassigned'}
          </SummaryItem>
        )}
        {/* Customer identity, placed between the technician and the payment status.
            Shows the booking's own customer record — the linked account's name and
            email when there is one, or the guest/walk-in details captured at
            booking time. This makes "who is this for" answerable without opening
            the sidebar, and works for walk-ins that have no profile row. */}
        {showCustomer && (
          <SummaryItem icon={User} label="Customer">
            <span style={{ display: 'block' }}>
              {customerName(booking)}
            </span>
            {customerEmail(booking) && (
              <span style={{ display: 'block', marginTop: '0.15rem', fontSize: '0.72rem', fontWeight: '600', color: 'var(--admin-text-secondary)' }}>
                {customerEmail(booking)}
              </span>
            )}
            <span style={{ display: 'block', marginTop: '0.2rem', fontSize: '0.65rem', fontWeight: '900', textTransform: 'uppercase' }}>
              <span style={{ color: booking?.customer_id ? 'var(--admin-brand)' : 'rgba(230, 30, 42, 0.62)' }}>
                {booking?.customer_id ? 'Customer Account' : 'Walk-in Guest'}
              </span>
            </span>
          </SummaryItem>
        )}
        {paymentStatus ? (() => {
          const badge = derivePaymentStatusBadge(booking, paymentStatus);
          if (!badge) return null;
          return (
            <SummaryItem icon={CreditCard} label="Payment Status">
              <span style={{ color: badge.color, fontWeight: '900' }}>
                {badge.text}
              </span>
              {badge.subtext && (
                <span style={{ display: 'block', marginTop: '0.15rem', fontSize: '0.65rem', fontWeight: '700', color: 'var(--admin-text-secondary)' }}>
                  {badge.subtext}
                </span>
              )}
            </SummaryItem>
          );
        })() : null}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', overflowX: 'auto', paddingTop: '0.5rem' }}>
        <div style={{ position: 'absolute', top: '22px', left: '8%', right: '8%', height: '2px', backgroundColor: 'var(--admin-border)', zIndex: 0 }} />
        {LIFECYCLE_STEPS.map((step, index) => {
          const isCompleted = index <= currentStepIndex;
          const isCurrent = index === currentStepIndex;
          return (
            <div key={step} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', zIndex: 1, minWidth: '80px', flex: '1 0 80px' }}>
              <div style={{ width: '24px', height: '24px', borderRadius: '50%', backgroundColor: isCompleted ? 'var(--admin-brand)' : 'var(--admin-bg)', border: `2px solid ${isCompleted ? 'var(--admin-brand)' : 'var(--admin-border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-on-brand)' }}>
                {isCompleted && <CheckCircle size={14} />}
              </div>
              <span style={{ fontSize: '0.7rem', fontWeight: isCurrent ? '700' : '400', color: isCurrent ? 'var(--admin-text-primary)' : 'var(--admin-text-secondary)', textAlign: 'center' }}>{step.replace('_', ' ')}</span>
              {step === 'COMPLETED' && rawStatus === 'COMPLETED' && onUnitCollected && (
                <button
                  onClick={onUnitCollected}
                  style={{ marginTop: '0.15rem', padding: '0.35rem 0.55rem', background: 'rgba(16, 185, 129, 0.1)', color: '#059669', border: '1px solid rgba(16, 185, 129, 0.45)', borderRadius: 'var(--admin-radius-sm)', fontSize: '0.55rem', fontWeight: '900', cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  UNIT COLLECTED
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const SummaryItem = ({ icon: Icon, label, children }) => (
 <div style={{ flex: '1 1 200px', display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
    <IconBox><Icon size={20} /></IconBox>
    <div style={{ minWidth: 0, flex: '1 1 auto' }}>
      <p style={labelStyle}>{label}</p>
      <div style={{ margin: 0, fontSize: '0.95rem', fontWeight: '600', color: 'var(--admin-text-primary)', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{children}</div>
    </div>
 </div>
);

const IconBox = ({ children }) => (
  <div style={{ padding: '0.5rem', backgroundColor: 'rgba(128, 128, 128, 0.1)', borderRadius: '8px', color: 'var(--admin-brand)', flexShrink: 0 }}>{children}</div>
);

const labelStyle = { margin: 0, fontSize: '0.75rem', color: 'var(--admin-text-secondary)' };

export default BookingSummaryHeader;
